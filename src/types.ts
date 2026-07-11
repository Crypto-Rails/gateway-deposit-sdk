/**
 * A blockchain identifier.
 * - `number`            → an EVM chain id, mainnet or testnet
 *                         (1 = Ethereum, 137 = Polygon, 84532 = Base Sepolia, …)
 * - `"solana-mainnet"`  → Solana mainnet-beta (`"solana"` is an alias)
 * - `"solana-devnet"`   → Solana devnet
 * - `"solana-testnet"`  → Solana testnet
 * - `"tron-mainnet"`    → Tron mainnet (`"tron"` is an alias)
 * - `"tron-shasta"`     → Tron Shasta testnet
 * - `"tron-nile"`       → Tron Nile testnet
 */
import type { RpcEndpoint } from "./rpc.js";
import type { Messages } from "./ui/i18n.js";
import type { ThemeTokens } from "./ui/styles.js";

export type { Messages } from "./ui/i18n.js";
export type { ThemeTokens } from "./ui/styles.js";

export type ChainId = number | (string & {});

/** A single deposit target the user should send funds to. */
export interface DepositTarget {
  /** Receiving address (0x… for EVM, base58 for Solana). */
  address: string;
  /**
   * The token to watch.
   * - Omit / `null` / `"native"` / the zero address → the chain's native coin
   *   (ETH, MATIC, SOL, …).
   * - An EVM contract address → that ERC-20 token.
   * - A Solana mint address → that SPL token.
   */
  tokenAddress?: string | null;
  /** Which chain the address lives on. See {@link ChainId}. */
  chainId: ChainId;
  /**
   * Optional decimals for display. If omitted the SDK will try to read it
   * on-chain (ERC-20 `decimals()` / SPL mint). Balance-increase detection does
   * not depend on this — it compares raw integer balances.
   */
  decimals?: number;
  /** Optional human label shown in the modal tab (e.g. "USDC on Base"). */
  label?: string;
}

/** Snapshot of one target's balance at a point in time. */
export interface BalanceSnapshot {
  /** Raw on-chain integer balance (wei / lamports / smallest unit). */
  raw: bigint;
  /** Token decimals used for formatting, if known. */
  decimals?: number;
  /** Best-effort token symbol for display, if known. */
  symbol?: string;
}

/** Emitted when a watched target receives new funds. */
export interface DepositEvent {
  target: DepositTarget;
  /** Balance before the deposit was detected. */
  previous: BalanceSnapshot;
  /** Balance after the deposit landed. */
  current: BalanceSnapshot;
  /** `current.raw - previous.raw`, the amount received (smallest unit). */
  deltaRaw: bigint;
  /** Human-formatted delta, e.g. "12.5" (uses decimals when known). */
  deltaFormatted: string;
}

/** How the watch session finished. */
export type DepositResolution =
  | { status: "funded"; event: DepositEvent }
  | { status: "all-funded"; events: DepositEvent[] }
  | { status: "closed" }
  | { status: "timeout" };

export interface WatchOptions {
  /**
   * Detection strategy:
   * - `"positive"` (default) → treat ANY balance at/above {@link minAmountRaw}
   *   as a received deposit. Best for fresh, single-use deposit addresses.
   * - `"increase"` → only fire when the balance rises above the value it had
   *   when the modal opened (baseline diff). Use for reused addresses.
   */
  detect?: "positive" | "increase";
  /**
   * Minimum raw (smallest-unit) balance that counts as a deposit in
   * `"positive"` mode. Default `1n` (any non-zero balance). Applied per target.
   */
  minAmountRaw?: bigint;
  /**
   * Minimum **deposit amount** (raw / smallest unit) that must accumulate before
   * the deposit is treated as complete. While the amount received since the modal
   * opened is below this, the watcher keeps polling — reporting partial progress
   * via {@link onPartialDeposit} and in the modal — instead of firing
   * {@link onDeposit} or resolving. So a payment that arrives in several
   * installments only completes once the running total is enough.
   *
   * Works in BOTH detect modes: the amount is measured as the delta over each
   * target's baseline (the opening balance in `"increase"` mode, or `0` in
   * `"positive"` mode). Unset → feature off: any qualifying deposit completes
   * immediately. This differs from {@link minAmountRaw}, which is merely the
   * `"positive"`-mode detection floor and fires on first crossing.
   */
  minDepositRaw?: bigint;
  /** Milliseconds between balance polls. Default `6000`. */
  pollIntervalMs?: number;
  /**
   * Give up after this many ms with no deposit. Resolves with
   * `{ status: "timeout" }`. Default: no timeout.
   */
  timeoutMs?: number;
  /**
   * When to resolve the `open()` promise:
   * - `"first"` (default) → as soon as ANY target is funded.
   * - `"all"`             → once EVERY target has been funded at least once.
   */
  resolveOn?: "first" | "all";
  /**
   * Keep the modal open after resolution so the user can read the toast.
   * Default `true` (auto-closes after {@link autoCloseDelayMs}).
   */
  autoClose?: boolean;
  /** Delay before auto-closing once funded. Default `2500`. */
  autoCloseDelayMs?: number;
  /**
   * Fired the moment a deposit is detected (even when `resolveOn: "all"`).
   * May be async — return a Promise (e.g. an API call to your backend) and the
   * SDK awaits it before resolving / auto-closing the modal.
   */
  onDeposit?: (event: DepositEvent) => void | Promise<void>;
  /**
   * Fired on each poll where a deposit has arrived but the running total is still
   * below {@link minDepositRaw} — i.e. only when `minDepositRaw` is set. Use it to
   * record partial payments or update your own UI. `event.deltaRaw` is the amount
   * received so far (baseline-relative); the shortfall is
   * `minDepositRaw - event.deltaRaw`. Not awaited — the poll loop keeps running.
   */
  onPartialDeposit?: (event: DepositEvent) => void | Promise<void>;
  /** Fired if the user dismisses the modal. */
  onClose?: () => void;
  /** Fired on each poll cycle with the latest snapshots (debug/telemetry). */
  onPoll?: (snapshots: Map<DepositTarget, BalanceSnapshot>) => void;
}

export interface DepositWatchConfig {
  /**
   * Override or extend the built-in RPC endpoints. Keyed by {@link ChainId}.
   * e.g. `{ 1: "https://my-eth-rpc", "solana-mainnet": "https://my-sol-rpc" }`
   *
   * A value may also be an array of URLs, which are load-balanced (round-robin)
   * and failed over in order — if one endpoint errors the next is tried, e.g.
   * `{ 1: ["https://rpc-a", "https://rpc-b"] }`.
   */
  rpcUrls?: Record<string | number, RpcEndpoint>;
  /**
   * Per-chain HTTP headers, keyed by {@link ChainId} — typically an API key.
   * The single best fix for TronGrid's aggressive free-tier rate limiting:
   * `{ "tron-mainnet": { "TRON-PRO-API-KEY": "<your-key>" } }`
   */
  rpcHeaders?: Record<string | number, Record<string, string>>;
  /** UI theme. Default `"auto"` (follows `prefers-color-scheme`). */
  theme?: "light" | "dark" | "auto";
  /**
   * Main modal header — typically your company / brand name. Overrides
   * `messages.title`. Default `"Deposit"`.
   */
  title?: string;
  /**
   * Small line under the header. Defaults to the localized "Fund your account"
   * ({@link Messages.subtitle}) for the chosen {@link locale}. Pass your own
   * string to override it, or `""` / `null` to hide the line entirely.
   */
  subtitle?: string | null;
  /**
   * Override the accent color (CSS color). Convenience shortcut for
   * `tokens.accent`. Default a calm indigo.
   */
  accent?: string;
  /**
   * Language for the modal's built-in strings. Accepts any built-in locale code
   * (`"en"`, `"es"`, `"fr"`, `"de"`, `"pt"`, `"zh"`, `"ja"`, `"ru"`); region
   * subtags fall back to the base language (`"pt-BR"` → `"pt"`). Unknown codes
   * fall back to English. Default `"en"`.
   */
  locale?: string;
  /**
   * Override individual UI strings, layered on top of the chosen {@link locale}.
   * Parameterized strings use `{name}` placeholders — see {@link Messages}.
   * `{ messages: { waiting: "Send funds to this address…" } }`
   */
  messages?: Partial<Messages>;
  /**
   * Override individual design tokens (colors, radius, fonts). The whole modal
   * re-themes consistently. `{ tokens: { accent: "#ff5a1f", radius: "8px" } }`
   */
  tokens?: Partial<ThemeTokens>;
  /**
   * Raw CSS appended inside the modal's shadow root, after the base stylesheet.
   * Redefine `--dw-*` custom properties or override any `.dw-*` rule for full
   * control. `{ css: ".dw-card { border-radius: 0 } .dw-title { font-size: 20px }" }`
   */
  css?: string;
  /** Fetch implementation override (SSR / custom agents). Default global `fetch`. */
  fetchFn?: typeof fetch;
}
