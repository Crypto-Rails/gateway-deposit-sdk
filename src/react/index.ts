import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createDepositWatcher } from "../watcher.js";
import { getBalances, type BalanceResult } from "../balances.js";
import type {
  DepositEvent,
  DepositResolution,
  DepositTarget,
  DepositWatchConfig,
  WatchOptions,
} from "../types.js";

export interface UseDepositWatch {
  /** Open the deposit modal. Resolves with the outcome. */
  open: (targets: DepositTarget[], options?: WatchOptions) => Promise<DepositResolution>;
  /** True while the modal is open and polling. */
  isWatching: boolean;
  /** The most recent resolution (funded / closed / timeout), or null. */
  lastResult: DepositResolution | null;
  /** The most recent completed deposit event across sessions, or null. */
  lastDeposit: DepositEvent | null;
  /**
   * The most recent partial-deposit event (received but still below
   * `minDepositRaw`), or null. Updates as installments accumulate; cleared to
   * `null` once the deposit completes. Only ever set when `minDepositRaw` is used.
   */
  lastPartial: DepositEvent | null;
}

/**
 * React hook wrapping the deposit watcher. The `config` is memoized by identity,
 * so pass a stable object (or wrap in `useMemo`) if it contains dynamic values.
 *
 * ```tsx
 * const { open, isWatching } = useDepositWatch({ title: "Add funds" });
 *
 * <button disabled={isWatching} onClick={() => open([
 *   { address, tokenAddress, chainId: 8453 },
 * ])}>Deposit</button>
 * ```
 */
export function useDepositWatch(config?: DepositWatchConfig): UseDepositWatch {
  const watcher = useMemo(() => createDepositWatcher(config), [config]);
  const [isWatching, setIsWatching] = useState(false);
  const [lastResult, setLastResult] = useState<DepositResolution | null>(null);
  const [lastDeposit, setLastDeposit] = useState<DepositEvent | null>(null);
  const [lastPartial, setLastPartial] = useState<DepositEvent | null>(null);
  const inFlight = useRef(false);

  const open = useCallback<UseDepositWatch["open"]>(
    async (targets, options) => {
      if (inFlight.current) {
        throw new Error("[deposit-watch] A deposit modal is already open.");
      }
      inFlight.current = true;
      setIsWatching(true);
      setLastPartial(null);
      try {
        const result = await watcher.open(targets, {
          ...options,
          onPartialDeposit: (event) => {
            setLastPartial(event);
            return options?.onPartialDeposit?.(event);
          },
          onDeposit: (event) => {
            setLastPartial(null);
            setLastDeposit(event);
            return options?.onDeposit?.(event);
          },
        });
        setLastResult(result);
        return result;
      } finally {
        inFlight.current = false;
        setIsWatching(false);
      }
    },
    [watcher],
  );

  return { open, isWatching, lastResult, lastDeposit, lastPartial };
}

export interface UseBalances {
  /** Latest batched read (same order as `targets`), or null before the first fetch. */
  balances: BalanceResult[] | null;
  /** True while a read is in flight. */
  isLoading: boolean;
  /** The error from the last failed read, or null. */
  error: Error | null;
  /**
   * Re-read the balances now. Reads the hook's current `targets` by default, or
   * pass an explicit list to read those instead. Resolves with the results.
   */
  refresh: (targets?: DepositTarget[]) => Promise<BalanceResult[]>;
}

/**
 * React hook wrapping {@link getBalances} — reads native + every listed token in
 * as few round-trips as possible (one Multicall3 call per EVM chain, one JSON-RPC
 * batch per Tron network). Fetches on mount and whenever the CONTENTS of
 * `targets` change (compared by value, so a fresh array literal each render is
 * fine). Call `refresh()` for manual/polled re-reads.
 *
 * ```tsx
 * const { balances, isLoading, refresh } = useBalances([
 *   { address, chainId: 1 },                       // native ETH
 *   { address, tokenAddress: USDC, chainId: 1 },   // ERC-20 — same multicall
 *   { address, tokenAddress: USDT, chainId: 1 },
 * ]);
 * ```
 */
export function useBalances(targets: DepositTarget[], config?: DepositWatchConfig): UseBalances {
  const [balances, setBalances] = useState<BalanceResult[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Latest values captured in refs so `refresh` stays stable (empty deps).
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const configRef = useRef(config);
  configRef.current = config;

  // Guard against setState after unmount; reset to true on (re)mount so React 18
  // StrictMode's mount→unmount→remount cycle doesn't leave it stuck false.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback<UseBalances["refresh"]>(async (next) => {
    const t = next ?? targetsRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const results = await getBalances(t, configRef.current);
      if (mounted.current) setBalances(results);
      return results;
    } catch (e) {
      if (mounted.current) setError(e as Error);
      throw e;
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  // Value-based key: refetch only when target contents actually change, not on
  // every render (the array identity changes each render, its contents may not).
  const key = useMemo(
    () => JSON.stringify(targets, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    [targets],
  );
  useEffect(() => {
    refresh().catch(() => {}); // error is captured in state; swallow the rejection
  }, [key, refresh]);

  return { balances, isLoading, error, refresh };
}

export {
  createDepositWatcher,
  watchDeposits,
  getBalance,
  getBalances,
  LOCALES,
  DEFAULT_LOCALE,
  resolveMessages,
  defaultTokens,
  resolveTokens,
} from "../index.js";
export type { BalanceResult } from "../balances.js";
export type {
  ChainId,
  DepositTarget,
  BalanceSnapshot,
  DepositEvent,
  DepositResolution,
  WatchOptions,
  DepositWatchConfig,
  Messages,
  ThemeTokens,
} from "../types.js";
