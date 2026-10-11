import { validateTarget } from "./address.js";
import { getBalances, type BalanceResult } from "./balances.js";
import { getBalance } from "./chains/index.js";
import { chainKey, isTron } from "./config.js";
import { formatUnits, shortenAddress } from "./format.js";
import { resolveMessages, t } from "./ui/i18n.js";
import { createModal, type DepositModalHandle } from "./ui/modal.js";
import type {
  BalanceSnapshot,
  DepositEvent,
  DepositResolution,
  DepositTarget,
  DepositWatchConfig,
  WatchOptions,
} from "./types.js";

const DEFAULTS: Required<
  Pick<
    WatchOptions,
    "detect" | "minAmountRaw" | "pollIntervalMs" | "resolveOn" | "autoClose" | "autoCloseDelayMs"
  >
> = {
  detect: "positive",
  minAmountRaw: 1n,
  pollIntervalMs: 6000,
  resolveOn: "first",
  autoClose: true,
  autoCloseDelayMs: 2500,
};

export interface DepositWatcher {
  /** Open the deposit modal and resolve when a deposit is detected (or closed/timeout). */
  open(targets: DepositTarget[], options?: WatchOptions): Promise<DepositResolution>;
}

export function createDepositWatcher(config: DepositWatchConfig = {}): DepositWatcher {
  return {
    open(targets, options = {}) {
      if (typeof document === "undefined") {
        return Promise.reject(
          new Error("[deposit-watch] open() requires a browser DOM environment."),
        );
      }
      if (!Array.isArray(targets) || targets.length === 0) {
        return Promise.reject(new Error("[deposit-watch] Provide at least one deposit target."));
      }

      // Validate the receiving address AND the token contract/mint (with
      // checksum) before opening the modal, so we never render a QR / watch a
      // deposit on a typo'd address or token.
      const validated: DepositTarget[] = [];
      const errors: string[] = [];
      targets.forEach((t, i) => {
        const v = validateTarget(t);
        for (const e of v.errors) {
          errors.push(`  • target[${i}] (chain ${String(t.chainId)}): ${e}`);
        }
        // Use the checksum-normalized forms downstream (display + QR + reads).
        validated.push({ ...t, address: v.normalized.address, tokenAddress: v.normalized.tokenAddress });
      });
      if (errors.length) {
        return Promise.reject(
          new Error(`[deposit-watch] Invalid deposit address(es):\n${errors.join("\n")}`),
        );
      }

      return runSession(validated, config, { ...DEFAULTS, ...options });
    },
  };
}

async function runSession(
  targets: DepositTarget[],
  config: DepositWatchConfig,
  opts: WatchOptions & typeof DEFAULTS,
): Promise<DepositResolution> {
  let modal: DepositModalHandle | null = null;
  const messages = resolveMessages(config.locale, config.messages);
  let settled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // Baseline balance per target (lazily set on first successful read so a
  // failed initial fetch can never look like an incoming deposit).
  const baseline = new Map<number, bigint>();
  const funded = new Set<number>();
  const events: DepositEvent[] = [];

  return new Promise<DepositResolution>((resolve) => {
    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const finish = (resolution: DepositResolution, closeNow = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      const destroy = () => modal?.destroy();
      if (closeNow || !opts.autoClose) {
        destroy();
      } else {
        setTimeout(destroy, opts.autoCloseDelayMs);
      }
      resolve(resolution);
    };

    const onClose = () => {
      opts.onClose?.();
      finish({ status: "closed" }, true);
    };

    (async () => {
      modal = await createModal(targets, config, { onClose });

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          modal?.setStatus(messages.timedOut, "error");
          finish({ status: "timeout" });
        }, opts.timeoutMs);
      }

      let polling = false;
      const decimalsCache = new Map<string, number>();
      const tokenKey = (target: DepositTarget) => `${chainKey(target.chainId)}:${target.tokenAddress ?? "native"}`;
      const tick = async () => {
        if (settled || polling) return;
        polling = true;
        try {
          const snapshots = new Map<DepositTarget, BalanceSnapshot>();

          const active = targets.flatMap((target, i) => funded.has(i) ? [] : [{ target, i }]);
          const reads = new Map<number, BalanceResult>();
          const tron = active.filter(({ target }) => isTron(target.chainId));
          const withDecimals = (target: DepositTarget) => ({
            ...target, decimals: target.decimals ?? decimalsCache.get(tokenKey(target)),
          });
          await Promise.all([
            getBalances(tron.map(({ target }) => withDecimals(target)), config).then(results => {
              tron.forEach(({ i }, index) => { if (results[index]) reads.set(i, results[index]!); });
            }),
            ...active.filter(({ target }) => !isTron(target.chainId)).map(async ({ target, i }) => {
              try {
                reads.set(i, { target, balance: await getBalance(target, config) });
              } catch { /* transient RPC error — try again next tick */ }
            }),
          ]);
          if (settled) return;
          await Promise.all(
            active.map(async ({ target, i }) => {
              const read = reads.get(i);
              if (!read || read.error) return; // transient RPC error — try again next tick
              const snap = read.balance;
              if (isTron(target.chainId) && snap.decimals !== undefined) decimalsCache.set(tokenKey(target), snap.decimals);
              snapshots.set(target, snap);

              // Resolve the baseline this deposit is measured against, and bail out
              // when nothing qualifying has arrived yet.
              let baseRaw: bigint;
              if (opts.detect === "increase") {
                // Baseline diff: only a rise above the opening balance counts.
                const base = baseline.get(i);
                if (base === undefined) {
                  baseline.set(i, snap.raw);
                  return;
                }
                if (snap.raw <= base) return;
                baseRaw = base;
              } else {
                // "positive": any balance at/above the detection floor is a deposit.
                if (snap.raw < opts.minAmountRaw) return;
                baseRaw = 0n;
              }

              // minDeposit gate: keep polling (accumulating) until the amount
              // received since the baseline is large enough. The baseline is left
              // untouched above, so successive installments add up across ticks.
              const receivedRaw = snap.raw - baseRaw;
              if (opts.minDepositRaw !== undefined && receivedRaw < opts.minDepositRaw) {
                reportPartial(i, target, baseRaw, snap);
                return;
              }

              await handleDeposit(i, target, baseRaw, snap);
            }),
          );

          opts.onPoll?.(snapshots);
        } finally {
          polling = false;
        }
      };

      // A deposit landed but the running total is still short of minDepositRaw:
      // surface progress and keep polling. NOT marked funded, so the next tick
      // re-reads and the delta keeps growing until the threshold is met.
      const reportPartial = (
        index: number,
        target: DepositTarget,
        baseRaw: bigint,
        current: BalanceSnapshot,
      ) => {
        const dec = current.decimals ?? 0;
        const receivedRaw = current.raw - baseRaw;
        const receivedFormatted = formatUnits(receivedRaw, dec);
        const sym = current.symbol ? ` ${current.symbol}` : "";

        if (modal?.getActiveIndex() === index) {
          const required = formatUnits(opts.minDepositRaw!, dec);
          modal.setStatus(
            t(messages.partial, { received: receivedFormatted, required, symbol: sym }),
            "waiting",
          );
        }

        // Fire-and-forget: partials recur every poll, so we never await (that
        // would stack slow handler calls). Errors are logged, not thrown.
        try {
          const r = opts.onPartialDeposit?.({
            target,
            previous: { raw: baseRaw, decimals: current.decimals, symbol: current.symbol },
            current,
            deltaRaw: receivedRaw,
            deltaFormatted: receivedFormatted,
          });
          if (r && typeof (r as Promise<void>).catch === "function") {
            (r as Promise<void>).catch((err) =>
              console.error("[deposit-watch] onPartialDeposit handler threw:", err),
            );
          }
        } catch (err) {
          console.error("[deposit-watch] onPartialDeposit handler threw:", err);
        }
      };

      const handleDeposit = async (
        index: number,
        target: DepositTarget,
        baseRaw: bigint,
        current: BalanceSnapshot,
      ) => {
        funded.add(index); // synchronous — prevents re-firing on the next tick
        const deltaRaw = current.raw - baseRaw;
        const deltaFormatted = formatUnits(deltaRaw, current.decimals ?? 0);
        const event: DepositEvent = {
          target,
          previous: { raw: baseRaw, decimals: current.decimals, symbol: current.symbol },
          current,
          deltaRaw,
          deltaFormatted,
        };
        events.push(event);

        modal?.markFunded(index);
        const sym = current.symbol ? ` ${current.symbol}` : "";
        modal?.toast(
          t(messages.toastReceived, {
            amount: deltaFormatted,
            symbol: sym,
            address: shortenAddress(target.address),
          }),
        );

        // Await the consumer's hook (e.g. an API call to their backend) so it
        // completes before the modal auto-closes / the promise resolves.
        try {
          await opts.onDeposit?.(event);
        } catch (err) {
          console.error("[deposit-watch] onDeposit handler threw:", err);
        }

        if (opts.resolveOn === "all") {
          if (funded.size === targets.length) {
            finish({ status: "all-funded", events });
          }
        } else {
          finish({ status: "funded", event });
        }
      };

      // Establish baselines immediately, then poll on an interval.
      await tick();
      timer = setInterval(tick, opts.pollIntervalMs);
    })().catch((err) => {
      modal?.setStatus(String(err?.message ?? err), "error");
      // Surface fatal setup errors as a close so callers aren't left hanging.
      finish({ status: "closed" }, true);
    });
  });
}
