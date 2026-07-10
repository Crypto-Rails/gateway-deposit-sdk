export { createDepositWatcher, type DepositWatcher } from "./watcher.js";
export { getBalance } from "./chains/index.js";
export { getBalances, type BalanceResult } from "./balances.js";
export {
  getEvmBalancesMulticall,
  encodeAggregate3,
  decodeAggregate3,
  MULTICALL3_ADDRESS,
} from "./multicall.js";
export { DEFAULT_RPC_URLS } from "./config.js";
export { formatUnits, shortenAddress } from "./format.js";
export { qrSvg } from "./qr.js";
export {
  LOCALES,
  DEFAULT_LOCALE,
  resolveMessages,
  type Messages,
} from "./ui/i18n.js";
export {
  defaultTokens,
  resolveTokens,
  type ThemeTokens,
} from "./ui/styles.js";
export {
  validateAddress,
  validateTarget,
  isNativeTokenRef,
  toChecksumAddress,
  isValidEvmAddress,
  isValidSolanaAddress,
  isValidTronAddress,
  tronBase58ToEvmHex,
  base58Decode,
  type AddressValidation,
  type TargetValidation,
} from "./address.js";

export type {
  ChainId,
  DepositTarget,
  BalanceSnapshot,
  DepositEvent,
  DepositResolution,
  WatchOptions,
  DepositWatchConfig,
} from "./types.js";

import { createDepositWatcher } from "./watcher.js";
import type {
  DepositResolution,
  DepositTarget,
  DepositWatchConfig,
  WatchOptions,
} from "./types.js";

/**
 * One-shot helper for the common case — open the deposit modal and await the
 * result without holding onto a watcher instance.
 *
 * ```ts
 * const result = await watchDeposits(
 *   [{ address: "0x…", tokenAddress: "0xA0b8…", chainId: 8453 }],
 *   { config: { title: "Fund your account" } },
 * );
 * if (result.status === "funded") console.log(result.event.deltaFormatted);
 * ```
 */
export function watchDeposits(
  targets: DepositTarget[],
  opts: WatchOptions & { config?: DepositWatchConfig } = {},
): Promise<DepositResolution> {
  const { config, ...watchOptions } = opts;
  return createDepositWatcher(config).open(targets, watchOptions);
}
