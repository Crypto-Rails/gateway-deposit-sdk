import { tronBase58ToEvmHex } from "../address.js";
import { rpcBatch, type RpcEndpoint, type RpcHeaders } from "../rpc.js";
import type { BalanceSnapshot, DepositTarget } from "../types.js";
import { getEvmBalance } from "./evm.js";

/**
 * Tron adapter built on Tron's Ethereum-compatible JSON-RPC (`/jsonrpc`).
 * Addresses are converted from base58 ("T…") to `0x` hex, then read exactly like
 * EVM: `eth_getBalance` for native TRX, `eth_call` `balanceOf`/`decimals` for
 * TRC-20. Native TRX has 6 decimals (balances are returned in SUN).
 */

const SEL_BALANCE_OF = "70a08231";
const SEL_DECIMALS = "313ce567";

export function isNativeTrx(tokenAddress?: string | null): boolean {
  if (!tokenAddress) return true;
  const t = tokenAddress.toLowerCase();
  return t === "native" || t === "trx";
}

export async function getTronBalance(
  rpcUrl: RpcEndpoint,
  address: string,
  tokenAddress: string | null | undefined,
  knownDecimals: number | undefined,
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<BalanceSnapshot> {
  const evmAddress = tronBase58ToEvmHex(address);
  const evmToken = isNativeTrx(tokenAddress) ? null : tronBase58ToEvmHex(tokenAddress!);
  return getEvmBalance(rpcUrl, evmAddress, evmToken, knownDecimals, fetchFn, {
    headers,
    nativeDecimals: 6,
    nativeSymbol: "TRX",
  });
}

/**
 * Read many Tron targets in a single JSON-RPC batch (one HTTP request). Tron has
 * no Multicall3 contract, but JSON-RPC batching collapses N calls into one,
 * which is what actually relieves rate-limit (429) pressure.
 */
export async function getTronBalancesBatch(
  rpcUrl: RpcEndpoint,
  targets: DepositTarget[],
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<BalanceSnapshot[]> {
  const plan = targets.map((t) => ({
    target: t,
    native: isNativeTrx(t.tokenAddress),
    balanceIdx: -1,
    decimalsIdx: -1,
  }));

  const calls: { method: string; params: unknown[] }[] = [];
  for (const p of plan) {
    const owner = tronBase58ToEvmHex(p.target.address);
    if (p.native) {
      calls.push({ method: "eth_getBalance", params: [owner, "latest"] });
      p.balanceIdx = calls.length - 1;
    } else {
      const token = tronBase58ToEvmHex(p.target.tokenAddress!);
      calls.push({
        method: "eth_call",
        params: [{ to: token, data: "0x" + SEL_BALANCE_OF + owner.slice(2).padStart(64, "0") }, "latest"],
      });
      p.balanceIdx = calls.length - 1;
      if (p.target.decimals === undefined) {
        calls.push({ method: "eth_call", params: [{ to: token, data: "0x" + SEL_DECIMALS }, "latest"] });
        p.decimalsIdx = calls.length - 1;
      }
    }
  }

  const results = await rpcBatch<string>(rpcUrl, calls, fetchFn, headers);

  return plan.map((p) => {
    const balRes = results[p.balanceIdx];
    const balHex = balRes?.result;
    const raw = balHex && balHex !== "0x" ? BigInt(balHex) : 0n;

    let decimals = p.target.decimals ?? (p.native ? 6 : 18);
    if (p.decimalsIdx >= 0) {
      const d = results[p.decimalsIdx]?.result;
      if (d && d !== "0x") decimals = Number(BigInt(d));
    }
    return { raw, decimals, symbol: p.native ? "TRX" : undefined };
  });
}
