import { getBalance } from "./chains/index.js";
import { getSolanaBalancesBatch } from "./chains/solana.js";
import { getTronBalancesBatch } from "./chains/tron.js";
import { chainKey, isSolana, isTron, resolveRpcHeaders, resolveRpcUrl } from "./config.js";
import { getEvmBalancesMulticall } from "./multicall.js";
import type { BalanceSnapshot, DepositTarget, DepositWatchConfig } from "./types.js";

/** A target paired with the balance read for it. */
export interface BalanceResult {
  target: DepositTarget;
  balance: BalanceSnapshot;
}

/**
 * Read the balance of every target — imported tokens and native coins — in as
 * few round-trips as possible. EVM targets are grouped by chain and read in a
 * single Multicall3 `eth_call` per chain; Solana and Tron targets are grouped by
 * chain and read in a single JSON-RPC batch per chain. Results come back in the
 * SAME order as `targets`.
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
  const balances = new Array<BalanceSnapshot>(targets.length);
  const zero: BalanceSnapshot = { raw: 0n, decimals: undefined, symbol: undefined };

  // Group by chain family: EVM → Multicall3, Tron & Solana → JSON-RPC batch.
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

  // Cap targets-per-request so one chain's group can span several parallel
  // batches, keeping each under a provider's batch / calldata limit.
  const maxBatch = normalizeMaxBatch(config.maxBatchSize);

  const fallbackIndividually = (group: Item[]) =>
    Promise.all(
      group.map(async (g) => {
        balances[g.index] = await getBalance(g.target, config).catch(() => zero);
      }),
    );

  for (const group of evmGroups.values()) {
    for (const part of chunk(group, maxBatch)) {
      jobs.push(
        (async () => {
          try {
            const snaps = await getEvmBalancesMulticall(
              part[0]!.target.chainId,
              part.map((g) => g.target),
              config,
            );
            part.forEach((g, i) => (balances[g.index] = snaps[i] ?? zero));
          } catch {
            // Chain lacks Multicall3, or the batched call failed — read one by one.
            await fallbackIndividually(part);
          }
        })(),
      );
    }
  }

  for (const group of tronGroups.values()) {
    for (const part of chunk(group, maxBatch)) {
      jobs.push(
        (async () => {
          try {
            const chainId = part[0]!.target.chainId;
            const snaps = await getTronBalancesBatch(
              resolveRpcUrl(chainId, config.rpcUrls),
              part.map((g) => g.target),
              config.fetchFn ?? fetch,
              resolveRpcHeaders(chainId, config.rpcHeaders),
            );
            part.forEach((g, i) => (balances[g.index] = snaps[i] ?? zero));
          } catch {
            // Batch unsupported / failed — read one by one.
            await fallbackIndividually(part);
          }
        })(),
      );
    }
  }

  for (const group of solanaGroups.values()) {
    for (const part of chunk(group, maxBatch)) {
      jobs.push(
        (async () => {
          try {
            const chainId = part[0]!.target.chainId;
            const snaps = await getSolanaBalancesBatch(
              resolveRpcUrl(chainId, config.rpcUrls),
              part.map((g) => g.target),
              config.fetchFn ?? fetch,
              resolveRpcHeaders(chainId, config.rpcHeaders),
            );
            part.forEach((g, i) => (balances[g.index] = snaps[i] ?? zero));
          } catch {
            // Batch unsupported / failed — read one by one.
            await fallbackIndividually(part);
          }
        })(),
      );
    }
  }

  await Promise.all(jobs);

  return targets.map((target, i) => ({ target, balance: balances[i] ?? zero }));
}

/** Normalize `maxBatchSize`: a positive integer, or `Infinity` for "no limit". */
function normalizeMaxBatch(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v < 1) return Infinity;
  return Math.floor(v);
}

/** Split into consecutive slices of at most `size` (order preserved). */
function chunk<T>(arr: T[], size: number): T[][] {
  if (!Number.isFinite(size) || arr.length <= size) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
