import { isSolana, isTron, resolveRpcHeaders, resolveRpcUrl } from "../config.js";
import type { BalanceSnapshot, DepositTarget, DepositWatchConfig } from "../types.js";
import { getEvmBalance } from "./evm.js";
import { getSolanaBalance } from "./solana.js";
import { getTronBalance } from "./tron.js";

/**
 * Read the current balance for a target, dispatching to the correct chain
 * adapter based on its `chainId`.
 */
export async function getBalance(
  target: DepositTarget,
  config: DepositWatchConfig,
): Promise<BalanceSnapshot> {
  const fetchFn = config.fetchFn ?? fetch;
  const rpcUrl = resolveRpcUrl(target.chainId, config.rpcUrls);
  const headers = resolveRpcHeaders(target.chainId, config.rpcHeaders);

  if (isSolana(target.chainId)) {
    return getSolanaBalance(rpcUrl, target.address, target.tokenAddress, target.decimals, fetchFn, headers);
  }
  if (isTron(target.chainId)) {
    return getTronBalance(rpcUrl, target.address, target.tokenAddress, target.decimals, fetchFn, headers);
  }
  return getEvmBalance(rpcUrl, target.address, target.tokenAddress, target.decimals, fetchFn, { headers });
}
