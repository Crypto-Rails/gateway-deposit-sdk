import { getBalance } from "./chains/index.js";
import { getSolanaBalancesBatch } from "./chains/solana.js";
import { getTronBalances } from "./chains/tron.js";
import { chainKey, isSolana, isTron, resolveRpcHeaders, resolveRpcUrls } from "./config.js";
import { getEvmBalancesMulticall } from "./multicall.js";
import type { BalanceSnapshot, DepositTarget, DepositWatchConfig } from "./types.js";

/** A target paired with the balance read for it. */
export interface BalanceResult {
  target: DepositTarget;
  balance: BalanceSnapshot;
  /** Read failed; balance is a placeholder and must not be used for deposit detection. */
  error?: Error;
}

/**
 * Read the balance of every target — imported tokens and native coins — in as
 * few round-trips as possible. EVM targets are grouped by chain and read in a
 * single Multicall3 `eth_call` per chain. TRON mainnet uses bounded Multicall3
 * chunks with JSON-RPC batch fallback; TRON testnets use batches. Solana uses
 * getMultipleAccounts for native balances and batches for tokens. Results retain
 * the input order.
 *
 * ```ts
 * const balances = await getBalances([
 *   { address, chainId: 1 },                          // native ETH
 *   { address, tokenAddress: USDC, chainId: 1 },      // ERC-20 — same multicall
 *   { address, tokenAddress: USDT, chainId: 1 },      // ERC-20 — same multicall
 *   { address: solAddr, chainId: "solana-mainnet" },  // separate call
 * ]);
 * ```
 */
export async function getBalances(
  targets: DepositTarget[],
  config: DepositWatchConfig = {},
): Promise<BalanceResult[]> {
  const errors = new Map<number, Error>();
  const balances = new Array<BalanceSnapshot>(targets.length);
  const zero: BalanceSnapshot = { raw: 0n, decimals: undefined, symbol: undefined };

  // Group by chain family and network before choosing the read strategy.
  type Item = { target: DepositTarget; index: number };
  const evmGroups = new Map<string, Item[]>();
  const tronGroups = new Map<string, Item[]>();
  const solanaGroups = new Map<string, Item[]>();

  targets.forEach((target, index) => {
    if (isSolana(target.chainId)) {
      const key = chainKey(target.chainId);
      (solanaGroups.get(key) ?? solanaGroups.set(key, []).get(key)!).push({ target, index });
    } else if (isTron(target.chainId)) {
      const key = chainKey(target.chainId);
      (tronGroups.get(key) ?? tronGroups.set(key, []).get(key)!).push({ target, index });
    } else {
      const key = chainKey(target.chainId);
      (evmGroups.get(key) ?? evmGroups.set(key, []).get(key)!).push({ target, index });
    }
  });

  const jobs: Promise<void>[] = [];

  const fallbackIndividually = (group: Item[]) =>
    Promise.all(
      group.map(async (g) => {
        try {
          balances[g.index] = await getBalance(g.target, config);
        } catch (error) {
          errors.set(g.index, error instanceof Error ? error : new Error(String(error)));
          balances[g.index] = zero;
        }
      }),
    );

  for (const group of evmGroups.values()) {
    jobs.push(
      (async () => {
        try {
          const snaps = await getEvmBalancesMulticall(
            group[0]!.target.chainId,
            group.map((g) => g.target),
            config,
          );
          group.forEach((g, i) => (balances[g.index] = snaps[i] ?? zero));
        } catch {
          // Chain lacks Multicall3, or the batched call failed — read one by one.
          await fallbackIndividually(group);
        }
      })(),
    );
  }

  for (const group of tronGroups.values()) {
    jobs.push(
      (async () => {
        try {
          const chainId = group[0]!.target.chainId;
          const snaps = await getTronBalances(
            resolveRpcUrls(chainId, config.rpcUrls),
            group.map((g) => g.target),
            config.fetchFn ?? fetch,
            resolveRpcHeaders(chainId, config.rpcHeaders),
            ["tron", "tron-mainnet"].includes(chainKey(chainId)),
          );
          await Promise.all(group.map(async (g, i) => {
            const snap = snaps[i];
            if (snap instanceof Error || !snap) await fallbackIndividually([g]);
            else balances[g.index] = snap;
          }));
        } catch {
          // Batch unsupported / failed — read one by one.
          await fallbackIndividually(group);
        }
      })(),
    );
  }

  for (const group of solanaGroups.values()) {
    jobs.push(
      (async () => {
        try {
          const chainId = group[0]!.target.chainId;
          const snaps = await getSolanaBalancesBatch(
            resolveRpcUrls(chainId, config.rpcUrls),
            group.map((g) => g.target),
            config.fetchFn ?? fetch,
            resolveRpcHeaders(chainId, config.rpcHeaders),
          );
          group.forEach((g, i) => (balances[g.index] = snaps[i] ?? zero));
        } catch {
          // Batch unsupported / failed — read one by one.
          await fallbackIndividually(group);
        }
      })(),
    );
  }

  await Promise.all(jobs);

  return targets.map((target, i) => ({
    target,
    balance: balances[i] ?? zero,
    ...(errors.has(i) ? { error: errors.get(i) } : {}),
  }));
}
