import { tronBase58ToEvmHex } from "../address.js";
import { decodeAggregate3, encodeAggregate3 } from "../multicall.js";
import { rpcCall, rpcBatch, type RpcEndpoint, type RpcHeaders } from "../rpc.js";
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
    strictTokenReads: true,
  });
}

/** Mainnet deployment from mds1/multicall3 deployments.json. */
const TRON_MULTICALL3 = tronBase58ToEvmHex("TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED");
const MAX_CALLS = 100;

/** Read bounded chunks; each failed aggregate falls back to a JSON-RPC batch. */
export async function getTronBalances(
  rpcUrl: RpcEndpoint,
  targets: DepositTarget[],
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
  useMulticall = false,
): Promise<Array<BalanceSnapshot | Error>> {
  const out: Array<BalanceSnapshot | Error> = [];
  // Metadata is shared across targets and chunks within this read.
  const decimalsCache = new Map<string, number>();
  for (const target of targets) {
    if (!isNativeTrx(target.tokenAddress) && target.decimals !== undefined) {
      decimalsCache.set(tronBase58ToEvmHex(target.tokenAddress!), target.decimals);
    }
  }

  let cursor = 0;
  while (cursor < targets.length) {
    const calls: Array<{ target: string; callData: string; method: string; params: unknown[] }> = [];
    const plan: Array<{ target: DepositTarget; native: boolean; token?: string; balanceIdx: number }> = [];
    const metadata = new Map<string, number>();
    while (cursor < targets.length) {
      const target = targets[cursor]!;
      const native = isNativeTrx(target.tokenAddress);
      const token = native ? undefined : tronBase58ToEvmHex(target.tokenAddress!);
      const needsDecimals = token !== undefined && !decimalsCache.has(token) && !metadata.has(token);
      if (calls.length + 1 + Number(needsDecimals) > MAX_CALLS) break;
      const owner = tronBase58ToEvmHex(target.address);
      const callData = (native ? "4d2301cc" : SEL_BALANCE_OF) + owner.slice(2).padStart(64, "0");
      const balanceIdx = calls.length;
      calls.push({
        target: token ?? TRON_MULTICALL3,
        callData,
        method: native ? "eth_getBalance" : "eth_call",
        params: native ? [owner, "latest"] : [{ to: token, data: "0x" + callData }, "latest"],
      });
      if (needsDecimals) {
        metadata.set(token!, calls.length);
        calls.push({ target: token!, callData: SEL_DECIMALS, method: "eth_call",
          params: [{ to: token, data: "0x" + SEL_DECIMALS }, "latest"] });
      }
      plan.push({ target, native, token, balanceIdx });
      cursor++;
    }

    let results: Array<{ result?: string; error?: unknown }>;
    try {
      if (!useMulticall) throw new Error("Use JSON-RPC batch on this network");
      const hex = await rpcCall<string>(rpcUrl, "eth_call",
        [{ to: TRON_MULTICALL3, data: encodeAggregate3(calls) }, "latest"], fetchFn, headers);
      const decoded = decodeAggregate3(hex);
      if (decoded.length !== calls.length) throw new Error("Incomplete TRON aggregate response");
      results = decoded.map(r => r.success && /^0x[0-9a-fA-F]{64}$/.test(r.data)
        ? { result: r.data } : { error: new Error("TRON subcall failed or returned invalid data") });
      // Retry failed subcalls only, preserving successful balances.
      const failed = results.flatMap((r, i) => r.error ? [i] : []);
      if (failed.length) {
        try {
          const retried = await rpcBatch<string>(rpcUrl, failed.map(i => calls[i]!), fetchFn, headers);
          failed.forEach((index, i) => { results[index] = retried[i] ?? { error: new Error("Missing TRON batch result") }; });
        } catch {
          // Keep successful aggregate results; unavailable balances fall back individually.
        }
      }
    } catch {
      try {
        results = await rpcBatch<string>(rpcUrl, calls, fetchFn, headers);
      } catch (error) {
        results = calls.map(() => ({ error }));
      }
    }

    for (const [token, index] of metadata) {
      const r = results[index];
      if (!r?.error && r?.result && /^0x[0-9a-fA-F]{64}$/.test(r.result)) {
        const decimals = Number(BigInt(r.result));
        if (Number.isInteger(decimals) && decimals >= 0 && decimals <= 255) decimalsCache.set(token, decimals);
      }
    }
    for (const p of plan) {
      const r = results[p.balanceIdx];
      if (r?.error || !r?.result || !(p.native ? /^0x[0-9a-fA-F]+$/ : /^0x[0-9a-fA-F]{64}$/).test(r.result)) {
        out.push(new Error("[deposit-watch] TRON balance read failed"));
        continue;
      }
      out.push({ raw: BigInt(r.result),
        decimals: p.target.decimals ?? (p.native ? 6 : decimalsCache.get(p.token!)),
        symbol: p.native ? "TRX" : undefined });
    }
  }
  return out;
}
