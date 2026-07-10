import type { ChainId } from "./types.js";

/**
 * Built-in public RPC endpoints. These are convenience defaults for getting
 * started — they are shared, rate-limited, and NOT meant for production load.
 * Override them via `createDepositWatcher({ rpcUrls: { ... } })`.
 */
export const DEFAULT_RPC_URLS: Record<string, string> = {
  // ---- EVM mainnets (keyed by numeric chain id, stored as string) ----
  "1": "https://ethereum-rpc.publicnode.com", // Ethereum
  "10": "https://optimism-rpc.publicnode.com", // Optimism
  "56": "https://bsc-rpc.publicnode.com", // BNB Smart Chain
  "137": "https://polygon-bor-rpc.publicnode.com", // Polygon
  "8453": "https://base-rpc.publicnode.com", // Base
  "42161": "https://arbitrum-one-rpc.publicnode.com", // Arbitrum One
  "43114": "https://avalanche-c-chain-rpc.publicnode.com", // Avalanche C-Chain

  // ---- EVM testnets ----
  "11155111": "https://ethereum-sepolia-rpc.publicnode.com", // Ethereum Sepolia
  "17000": "https://ethereum-holesky-rpc.publicnode.com", // Ethereum Holesky
  "560048": "https://ethereum-hoodi-rpc.publicnode.com", // Ethereum Hoodi
  "11155420": "https://optimism-sepolia-rpc.publicnode.com", // Optimism Sepolia
  "97": "https://bsc-testnet-rpc.publicnode.com", // BNB Smart Chain testnet
  "80002": "https://polygon-amoy-bor-rpc.publicnode.com", // Polygon Amoy
  "84532": "https://base-sepolia-rpc.publicnode.com", // Base Sepolia
  "421614": "https://arbitrum-sepolia-rpc.publicnode.com", // Arbitrum Sepolia
  "43113": "https://avalanche-fuji-c-chain-rpc.publicnode.com", // Avalanche Fuji

  // ---- Solana (keyed by cluster alias) ----
  "solana": "https://api.mainnet-beta.solana.com",
  "solana-mainnet": "https://api.mainnet-beta.solana.com",
  "solana-devnet": "https://api.devnet.solana.com",
  "solana-testnet": "https://api.testnet.solana.com",

  // ---- Tron (Ethereum-compatible JSON-RPC endpoints, keyed by cluster alias) ----
  "tron": "https://api.trongrid.io/jsonrpc",
  "tron-mainnet": "https://api.trongrid.io/jsonrpc",
  "tron-shasta": "https://api.shasta.trongrid.io/jsonrpc", // testnet
  "tron-nile": "https://nile.trongrid.io/jsonrpc", // testnet
};

/** True when the chain id refers to a Solana cluster. */
export function isSolana(chainId: ChainId): boolean {
  return typeof chainId === "string" && chainId.toLowerCase().startsWith("solana");
}

/** True when the chain id refers to a Tron network. */
export function isTron(chainId: ChainId): boolean {
  return typeof chainId === "string" && chainId.toLowerCase().startsWith("tron");
}

/** Normalize a chain id into the key used in the RPC map. */
export function chainKey(chainId: ChainId): string {
  return typeof chainId === "string" ? chainId.toLowerCase() : String(chainId);
}

export function resolveRpcUrl(
  chainId: ChainId,
  overrides?: Record<string | number, string>,
): string {
  const key = chainKey(chainId);
  const fromOverride =
    overrides?.[key] ?? overrides?.[chainId as never] ?? overrides?.[String(chainId)];
  const url = fromOverride ?? DEFAULT_RPC_URLS[key];
  if (!url) {
    throw new Error(
      `[deposit-watch] No RPC URL configured for chain "${String(chainId)}". ` +
        `Pass one via createDepositWatcher({ rpcUrls: { "${String(chainId)}": "https://…" } }).`,
    );
  }
  return url;
}

/** Resolve per-chain HTTP headers (e.g. an API key) for a chain, if any. */
export function resolveRpcHeaders(
  chainId: ChainId,
  overrides?: Record<string | number, Record<string, string>>,
): Record<string, string> | undefined {
  if (!overrides) return undefined;
  const key = chainKey(chainId);
  return overrides[key] ?? overrides[chainId as never] ?? overrides[String(chainId)];
}
