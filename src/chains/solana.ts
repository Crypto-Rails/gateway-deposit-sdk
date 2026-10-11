import { rpcBatch, rpcCall, type RpcEndpoint, type RpcHeaders } from "../rpc.js";
import type { BalanceSnapshot, DepositTarget } from "../types.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Max pubkeys a single `getMultipleAccounts` call accepts. This is a protocol
 * limit ("Too many inputs provided; max 100"), not a provider quirk, so native
 * reads are chunked at this size regardless of endpoint.
 */
const MAX_ACCOUNTS_PER_CALL = 100;

/** Shape of a `getBalance` result: the lamport count wrapped in an RPC context. */
type SolBalanceResult = { value: number };

/** One account slot from a `getMultipleAccounts` result (or `null` if absent). */
type SolAccount = { lamports: number } | null;

/** Shape of a `getMultipleAccounts` result: accounts in the requested order. */
type SolMultipleAccountsResult = { value: SolAccount[] };

/** Shape of a `getTokenAccountsByOwner` result: the owner's SPL accounts. */
type SolTokenAccountsResult = {
  value: Array<{
    account: {
      data: { parsed: { info: { tokenAmount: { amount: string; decimals: number } } } };
    };
  }>;
};

/** Sum every SPL token account into a single snapshot for the given mint. */
function sumTokenAccounts(
  res: SolTokenAccountsResult | undefined,
  knownDecimals: number | undefined,
): BalanceSnapshot {
  let raw = 0n;
  let decimals = knownDecimals;
  for (const acc of res?.value ?? []) {
    const amt = acc.account?.data?.parsed?.info?.tokenAmount;
    if (!amt) continue;
    raw += BigInt(amt.amount);
    if (decimals === undefined) decimals = amt.decimals;
  }
  return { raw, decimals: decimals ?? 0, symbol: undefined };
}

export function isNativeSol(tokenAddress?: string | null): boolean {
  if (!tokenAddress) return true;
  const t = tokenAddress.toLowerCase();
  return t === "native" || t === "sol";
}

export async function getSolanaBalance(
  rpcUrl: RpcEndpoint,
  address: string,
  tokenAddress: string | null | undefined,
  knownDecimals: number | undefined,
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<BalanceSnapshot> {
  if (isNativeSol(tokenAddress)) {
    const res = await rpcCall<SolBalanceResult>(rpcUrl, "getBalance", [address], fetchFn, headers);
    return { raw: BigInt(res.value ?? 0), decimals: knownDecimals ?? 9, symbol: "SOL" };
  }

  // Sum every SPL token account the owner holds for this mint.
  const res = await rpcCall<SolTokenAccountsResult>(
    rpcUrl,
    "getTokenAccountsByOwner",
    [
      address,
      { mint: tokenAddress },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ],
    fetchFn,
    headers,
  );

  return sumTokenAccounts(res, knownDecimals);
}

/**
 * Read many Solana targets in as few HTTP requests as possible, results lined up
 * 1:1 with `targets`.
 *
 * Native SOL targets are read with `getMultipleAccounts`, which returns up to
 * {@link MAX_ACCOUNTS_PER_CALL} accounts (their lamports) in a single method call
 * at one consistent slot. This is far cheaper on the rate limiter than one
 * `getBalance` per address: providers meter it as ~1 request per 100 addresses,
 * and public nodes that throttle per-call `getBalance` batches down to a handful
 * still serve a full 100-key `getMultipleAccounts`. Native reads are therefore
 * chunked at 100, one HTTP request per chunk (fired in parallel) — public nodes
 * reject more than one `getMultipleAccounts` per JSON-RPC batch, so combining
 * chunks into one batch is not portable. Requests fail over across the endpoint
 * list, which also covers nodes (e.g. publicnode) that block the method outright.
 *
 * Solana has no `getMultipleAccounts` equivalent for "sum an owner's SPL accounts
 * for a mint", so SPL targets stay on `getTokenAccountsByOwner`, collapsed into a
 * single JSON-RPC batch. For >100 native targets on a shared public node, expect
 * some chunks to be rate-limited (429) — point the SDK at a dedicated RPC.
 */
export async function getSolanaBalancesBatch(
  rpcUrl: RpcEndpoint,
  targets: DepositTarget[],
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<BalanceSnapshot[]> {
  const out = new Array<BalanceSnapshot>(targets.length);

  const native: Array<{ index: number; target: DepositTarget }> = [];
  const token: Array<{ index: number; target: DepositTarget }> = [];
  targets.forEach((target, index) => {
    (isNativeSol(target.tokenAddress) ? native : token).push({ index, target });
  });

  const jobs: Promise<void>[] = [];

  // Native SOL → getMultipleAccounts, chunked at the 100-key protocol limit.
  for (let c = 0; c < native.length; c += MAX_ACCOUNTS_PER_CALL) {
    const chunk = native.slice(c, c + MAX_ACCOUNTS_PER_CALL);
    jobs.push(
      (async () => {
        const res = await rpcCall<SolMultipleAccountsResult>(
          rpcUrl,
          "getMultipleAccounts",
          [
            chunk.map((n) => n.target.address),
            { encoding: "base64", dataSlice: { offset: 0, length: 0 } },
          ],
          fetchFn,
          headers,
        );
        const values = res?.value ?? [];
        chunk.forEach((n, k) => {
          out[n.index] = {
            raw: BigInt(values[k]?.lamports ?? 0),
            decimals: n.target.decimals ?? 9,
            symbol: "SOL",
          };
        });
      })(),
    );
  }

  // SPL tokens → one getTokenAccountsByOwner per target, in a single batch.
  if (token.length > 0) {
    jobs.push(
      (async () => {
        const results = await rpcBatch<SolTokenAccountsResult>(
          rpcUrl,
          token.map((t) => ({
            method: "getTokenAccountsByOwner",
            params: [
              t.target.address,
              { mint: t.target.tokenAddress },
              { encoding: "jsonParsed", commitment: "confirmed" },
            ],
          })),
          fetchFn,
          headers,
        );
        token.forEach((t, i) => {
          out[t.index] = sumTokenAccounts(results[i]?.result, t.target.decimals);
        });
      })(),
    );
  }

  await Promise.all(jobs);
  return out;
}

// Exported for potential future use (e.g. validating a mint's program owner).
export const _SPL_TOKEN_PROGRAM = SPL_TOKEN_PROGRAM;
