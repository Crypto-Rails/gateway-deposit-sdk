import { rpcCall, type RpcEndpoint, type RpcHeaders } from "../rpc.js";
import type { BalanceSnapshot } from "../types.js";

export interface EvmBalanceOptions {
  headers?: RpcHeaders;
  /** Decimals for the native coin. Default 18 (ETH); Tron passes 6 (TRX). */
  nativeDecimals?: number;
  /** Symbol for the native coin, for display. */
  nativeSymbol?: string;
  /** TRON requires real ABI return data and keeps failed metadata unresolved. */
  strictTokenReads?: boolean;
}

const ZERO = "0x0000000000000000000000000000000000000000";

// ERC-20 function selectors.
const SEL_BALANCE_OF = "0x70a08231"; // balanceOf(address)
const SEL_DECIMALS = "0x313ce567"; // decimals()
const SEL_SYMBOL = "0x95d89b41"; // symbol()

export function isNativeToken(tokenAddress?: string | null): boolean {
  if (!tokenAddress) return true;
  const t = tokenAddress.toLowerCase();
  return t === "native" || t === ZERO || t === "0x0" || t === "eth";
}

function padAddress(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return clean.padStart(64, "0");
}

async function ethCall(
  url: RpcEndpoint,
  to: string,
  data: string,
  fetchFn: typeof fetch,
  headers?: RpcHeaders,
): Promise<string> {
  return rpcCall<string>(url, "eth_call", [{ to, data }, "latest"], fetchFn, headers);
}

/** Decode a solidity `string` return value (ABI head+len+bytes). */
function decodeAbiString(hex: string): string | undefined {
  try {
    const body = hex.replace(/^0x/, "");
    if (body.length < 128) return undefined;
    const len = parseInt(body.slice(64, 128), 16);
    const bytes = body.slice(128, 128 + len * 2);
    let out = "";
    for (let i = 0; i < bytes.length; i += 2) {
      out += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    }
    return out.replace(/\0+$/, "") || undefined;
  } catch {
    return undefined;
  }
}

export async function getEvmBalance(
  rpcUrl: RpcEndpoint,
  address: string,
  tokenAddress: string | null | undefined,
  knownDecimals: number | undefined,
  fetchFn: typeof fetch,
  opts: EvmBalanceOptions = {},
): Promise<BalanceSnapshot> {
  const { headers, nativeDecimals = 18, nativeSymbol } = opts;

  if (isNativeToken(tokenAddress)) {
    const hex = await rpcCall<string>(rpcUrl, "eth_getBalance", [address, "latest"], fetchFn, headers);
    return { raw: BigInt(hex), decimals: knownDecimals ?? nativeDecimals, symbol: nativeSymbol };
  }

  const token = tokenAddress as string;
  const balanceData = SEL_BALANCE_OF + padAddress(address);

  // Fetch balance first (required); decimals + symbol are best-effort.
  const balHex = await ethCall(rpcUrl, token, balanceData, fetchFn, headers);
  if (opts.strictTokenReads && !/^0x[0-9a-fA-F]{64}$/.test(balHex ?? "")) {
    throw new Error("[deposit-watch] Invalid token balance response");
  }
  const raw = BigInt(balHex === "0x" ? "0x0" : balHex);

  let decimals = knownDecimals;
  let symbol: string | undefined;
  if (decimals === undefined) {
    try {
      const decHex = await ethCall(rpcUrl, token, SEL_DECIMALS, fetchFn, headers);
      if (opts.strictTokenReads && !/^0x[0-9a-fA-F]{64}$/.test(decHex ?? "")) {
        throw new Error("Invalid token decimals response");
      }
      decimals = decHex && decHex !== "0x" ? Number(BigInt(decHex)) : 18;
      if (opts.strictTokenReads && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
        throw new Error("Invalid token decimals value");
      }
    } catch {
      decimals = opts.strictTokenReads ? undefined : 18;
    }
  }
  try {
    const symHex = await ethCall(rpcUrl, token, SEL_SYMBOL, fetchFn, headers);
    symbol = decodeAbiString(symHex);
  } catch {
    /* ignore — symbol is decorative */
  }

  return { raw, decimals, symbol };
}
