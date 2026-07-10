import { rpcBatch, rpcCall, type RpcHeaders } from "../rpc.js";
import type { BalanceSnapshot, DepositTarget } from "../types.js";

const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Shape of a `getBalance` result: the lamport count wrapped in an RPC context. */
type SolBalanceResult = { value: number };

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
  rpcUrl: string,
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
 * Read many Solana targets in a single JSON-RPC batch (one HTTP request).
 * Solana has no Multicall3 contract, but its JSON-RPC supports standard 2.0
 * batching, which collapses N calls into one and relieves rate-limit (429)
 * pressure. Each target maps to exactly one call — `getBalance` for native SOL,
 * `getTokenAccountsByOwner` for SPL — so results line up 1:1 with `targets`.
 */
export async function getSolanaBalancesBatch(
  rpcUrl: string,
  targets: DepositTarget[],
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<BalanceSnapshot[]> {
  const plan = targets.map((t) => ({ target: t, native: isNativeSol(t.tokenAddress) }));

  const calls = plan.map((p) =>
    p.native
      ? { method: "getBalance", params: [p.target.address] }
      : {
          method: "getTokenAccountsByOwner",
          params: [
            p.target.address,
            { mint: p.target.tokenAddress },
            { encoding: "jsonParsed", commitment: "confirmed" },
          ],
        },
  );

  const results = await rpcBatch<SolBalanceResult | SolTokenAccountsResult>(
    rpcUrl,
    calls,
    fetchFn,
    headers,
  );

  return plan.map((p, i) => {
    const res = results[i]?.result;
    if (p.native) {
      const value = (res as SolBalanceResult | undefined)?.value;
      return { raw: BigInt(value ?? 0), decimals: p.target.decimals ?? 9, symbol: "SOL" };
    }
    return sumTokenAccounts(res as SolTokenAccountsResult | undefined, p.target.decimals);
  });
}

// Exported for potential future use (e.g. validating a mint's program owner).
export const _SPL_TOKEN_PROGRAM = SPL_TOKEN_PROGRAM;
