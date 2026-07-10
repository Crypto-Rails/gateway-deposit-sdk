import { sha256 } from "@noble/hashes/sha256";
import { keccak_256 } from "@noble/hashes/sha3";
import { isSolana, isTron } from "./config.js";
import type { ChainId } from "./types.js";

// ---- small helpers ----

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function asciiToBytes(str: string): Uint8Array {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i);
  return out;
}

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string to bytes. Throws on an invalid character. */
export function base58Decode(input: string): Uint8Array {
  const bytes: number[] = [0];
  for (const ch of input) {
    const value = B58_ALPHABET.indexOf(ch);
    if (value === -1) throw new Error(`invalid base58 character "${ch}"`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Preserve leading zeros (encoded as '1').
  for (const ch of input) {
    if (ch === "1") bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

// ---- EVM (EIP-55) ----

/** Convert an EVM address to its EIP-55 checksummed form. */
export function toChecksumAddress(address: string): string {
  const addr = address.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(asciiToBytes(addr)));
  let out = "0x";
  for (let i = 0; i < addr.length; i++) {
    out += parseInt(hash[i]!, 16) >= 8 ? addr[i]!.toUpperCase() : addr[i]!;
  }
  return out;
}

export function isValidEvmAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  const body = address.slice(2);
  const hasUpper = /[A-F]/.test(body);
  const hasLower = /[a-f]/.test(body);
  // All-one-case is a valid (un-checksummed) address; mixed case must checksum.
  if (hasUpper && hasLower) return toChecksumAddress(address) === address;
  return true;
}

// ---- Solana ----

export function isValidSolanaAddress(address: string): boolean {
  try {
    return base58Decode(address).length === 32;
  } catch {
    return false;
  }
}

// ---- Tron (base58check, 0x41 prefix) ----

/**
 * Convert a base58 Tron address ("T…") to the EVM-style `0x` + 20-byte hex form
 * used by Tron's Ethereum-compatible JSON-RPC (drops the 0x41 prefix and the
 * 4-byte checksum).
 */
export function tronBase58ToEvmHex(address: string): string {
  const d = base58Decode(address);
  if (d.length !== 25 || d[0] !== 0x41) {
    throw new Error(`[deposit-watch] invalid Tron address "${address}"`);
  }
  let hex = "0x";
  for (let i = 1; i < 21; i++) hex += d[i]!.toString(16).padStart(2, "0");
  return hex;
}

export function isValidTronAddress(address: string): boolean {
  try {
    const decoded = base58Decode(address);
    if (decoded.length !== 25 || decoded[0] !== 0x41) return false;
    const payload = decoded.slice(0, 21);
    const checksum = decoded.slice(21);
    const expected = sha256(sha256(payload)).slice(0, 4);
    for (let i = 0; i < 4; i++) if (checksum[i] !== expected[i]) return false;
    return true;
  } catch {
    return false;
  }
}

export interface AddressValidation {
  ok: boolean;
  /** Canonical form (EIP-55 checksum for EVM; unchanged otherwise). */
  normalized: string;
  /** Human-readable reason when `ok` is false. */
  error?: string;
}

/**
 * True when `tokenAddress` refers to the chain's native coin rather than a
 * token contract/mint (so it needs no contract-address validation).
 */
export function isNativeTokenRef(
  tokenAddress: string | null | undefined,
  chainId: ChainId,
): boolean {
  if (!tokenAddress) return true;
  const t = tokenAddress.trim().toLowerCase();
  if (t === "" || t === "native") return true;
  if (isSolana(chainId)) return t === "sol";
  if (isTron(chainId)) return t === "trx";
  // EVM
  return t === "eth" || t === "0x0" || t === "0x0000000000000000000000000000000000000000";
}

/** Validate an address for the given chain, checksum included. */
export function validateAddress(address: string, chainId: ChainId): AddressValidation {
  const addr = (address ?? "").trim();
  if (!addr) return { ok: false, normalized: addr, error: "address is empty" };

  if (isSolana(chainId)) {
    return isValidSolanaAddress(addr)
      ? { ok: true, normalized: addr }
      : { ok: false, normalized: addr, error: "not a valid Solana (base58, 32-byte) address" };
  }

  if (isTron(chainId)) {
    return isValidTronAddress(addr)
      ? { ok: true, normalized: addr }
      : { ok: false, normalized: addr, error: "not a valid Tron (base58check, T-prefixed) address" };
  }

  // EVM
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    return { ok: false, normalized: addr, error: "not a valid EVM address (expected 0x + 40 hex)" };
  }
  if (!isValidEvmAddress(addr)) {
    return {
      ok: false,
      normalized: toChecksumAddress(addr),
      error: "bad EIP-55 checksum — mixed-case address does not match its checksum",
    };
  }
  return { ok: true, normalized: toChecksumAddress(addr) };
}

export interface TargetValidation {
  ok: boolean;
  /** Validation of the receiving address. */
  address: AddressValidation;
  /** Validation of the token contract/mint — `null` for native-coin targets. */
  tokenAddress: AddressValidation | null;
  /** Canonical forms to use downstream (EIP-55 checksum on EVM). */
  normalized: { address: string; tokenAddress: string | null };
  /** Human-readable reasons, empty when `ok`. */
  errors: string[];
}

/**
 * Validate a deposit target — both the receiving address AND the token
 * contract/mint (when it isn't the native coin) — with chain-aware checksums.
 */
export function validateTarget(target: {
  address: string;
  tokenAddress?: string | null;
  chainId: ChainId;
}): TargetValidation {
  const errors: string[] = [];

  const address = validateAddress(target.address, target.chainId);
  if (!address.ok) errors.push(`address "${target.address}": ${address.error}`);

  let tokenAddress: AddressValidation | null = null;
  let normalizedToken: string | null = target.tokenAddress ?? null;
  if (!isNativeTokenRef(target.tokenAddress, target.chainId)) {
    tokenAddress = validateAddress(target.tokenAddress as string, target.chainId);
    if (!tokenAddress.ok) errors.push(`tokenAddress "${target.tokenAddress}": ${tokenAddress.error}`);
    normalizedToken = tokenAddress.normalized;
  }

  return {
    ok: errors.length === 0,
    address,
    tokenAddress,
    normalized: { address: address.normalized, tokenAddress: normalizedToken },
    errors,
  };
}
