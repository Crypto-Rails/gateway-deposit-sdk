import { isNativeToken } from "./chains/evm.js";
import { resolveRpcHeaders, resolveRpcUrl } from "./config.js";
import { rpcCall } from "./rpc.js";
import type { BalanceSnapshot, ChainId, DepositTarget, DepositWatchConfig } from "./types.js";

/**
 * Multicall3 is deployed at this same address on virtually every EVM chain
 * (mainnets and testnets). https://www.multicall3.com
 */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const SEL_AGGREGATE3 = "82ad56cb"; // aggregate3((address,bool,bytes)[])
const SEL_GET_ETH_BALANCE = "4d2301cc"; // getEthBalance(address)
const SEL_BALANCE_OF = "70a08231"; // balanceOf(address)
const SEL_DECIMALS = "313ce567"; // decimals()

interface Call {
  target: string;
  callData: string; // hex, with or without 0x
}

// ---- minimal ABI helpers (hex string math, no external deps) ----

function word(n: number | bigint): string {
  return BigInt(n).toString(16).padStart(64, "0");
}

function addrArg(address: string): string {
  return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function encodeBytes(dataNo0x: string): string {
  const byteLen = dataNo0x.length / 2;
  const padded = dataNo0x.padEnd(Math.ceil(dataNo0x.length / 64) * 64, "0");
  return word(byteLen) + padded;
}

// tuple(address target, bool allowFailure, bytes callData) — dynamic (has bytes)
function encodeElement(target: string, allowFailure: boolean, callDataNo0x: string): string {
  return (
    addrArg(target) + // address
    word(allowFailure ? 1 : 0) + // bool
    word(0x60) + // offset to bytes within this tuple (3 words in)
    encodeBytes(callDataNo0x)
  );
}

/** ABI-encode `aggregate3((address,bool,bytes)[])` calldata for the given calls. */
export function encodeAggregate3(calls: Call[]): string {
  const elems = calls.map((c) => encodeElement(c.target, true, c.callData.replace(/^0x/, "")));

  let offsets = "";
  let tail = "";
  let running = calls.length * 32; // bytes: the block of N offset words
  for (const e of elems) {
    offsets += word(running);
    running += e.length / 2;
    tail += e;
  }

  const array = word(calls.length) + offsets + tail;
  const head = word(0x20); // single dynamic-array param → offset 0x20
  return "0x" + SEL_AGGREGATE3 + head + array;
}

/** Decode the `(bool success, bytes returnData)[]` result of aggregate3. */
export function decodeAggregate3(retHex: string): Array<{ success: boolean; data: string }> {
  const h = retHex.replace(/^0x/, "");
  const arrStart = Number(BigInt("0x" + h.slice(0, 64))) * 2; // offset to array (chars)
  const n = Number(BigInt("0x" + h.slice(arrStart, arrStart + 64)));
  const offsetsStart = arrStart + 64; // right after the length word

  const out: Array<{ success: boolean; data: string }> = [];
  for (let i = 0; i < n; i++) {
    const offWord = h.slice(offsetsStart + i * 64, offsetsStart + i * 64 + 64);
    const elemStart = offsetsStart + Number(BigInt("0x" + offWord)) * 2;
    const success = BigInt("0x" + h.slice(elemStart, elemStart + 64)) !== 0n;
    const bytesOff = Number(BigInt("0x" + h.slice(elemStart + 64, elemStart + 128))) * 2;
    const bytesStart = elemStart + bytesOff;
    const bytesLen = Number(BigInt("0x" + h.slice(bytesStart, bytesStart + 64))) * 2;
    const data = h.slice(bytesStart + 64, bytesStart + 64 + bytesLen);
    out.push({ success, data: "0x" + (data || "") });
  }
  return out;
}

/**
 * Read balances for many EVM targets on a single chain in ONE `eth_call` via
 * Multicall3. Native balances use `getEthBalance`; tokens use `balanceOf`
 * (plus `decimals()` when not supplied on the target).
 */
export async function getEvmBalancesMulticall(
  chainId: ChainId,
  targets: DepositTarget[],
  config: DepositWatchConfig,
): Promise<BalanceSnapshot[]> {
  const rpcUrl = resolveRpcUrl(chainId, config.rpcUrls);
  const fetchFn = config.fetchFn ?? fetch;
  const headers = resolveRpcHeaders(chainId, config.rpcHeaders);

  const plan = targets.map((t) => ({
    target: t,
    native: isNativeToken(t.tokenAddress),
    balanceIdx: -1,
    decimalsIdx: -1,
  }));

  const calls: Call[] = [];
  for (const p of plan) {
    if (p.native) {
      calls.push({ target: MULTICALL3_ADDRESS, callData: SEL_GET_ETH_BALANCE + addrArg(p.target.address) });
      p.balanceIdx = calls.length - 1;
    } else {
      calls.push({ target: p.target.tokenAddress!, callData: SEL_BALANCE_OF + addrArg(p.target.address) });
      p.balanceIdx = calls.length - 1;
      if (p.target.decimals === undefined) {
        calls.push({ target: p.target.tokenAddress!, callData: SEL_DECIMALS });
        p.decimalsIdx = calls.length - 1;
      }
    }
  }

  const ret = await rpcCall<string>(
    rpcUrl,
    "eth_call",
    [{ to: MULTICALL3_ADDRESS, data: encodeAggregate3(calls) }, "latest"],
    fetchFn,
    headers,
  );
  const decoded = decodeAggregate3(ret);

  return plan.map((p) => {
    const b = decoded[p.balanceIdx];
    const raw = b?.success && b.data.length >= 66 ? BigInt(b.data.slice(0, 66)) : 0n;

    let decimals = p.target.decimals ?? 18;
    if (p.decimalsIdx >= 0) {
      const d = decoded[p.decimalsIdx];
      if (d?.success && d.data !== "0x") decimals = Number(BigInt(d.data));
    }
    return { raw, decimals, symbol: undefined };
  });
}
