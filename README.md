# deposit-watch

A drop-in frontend SDK for crypto deposit flows. Its two core functions are:

1. **`watchDeposits()`** — pop a QR deposit modal for a set of targets, poll the
   chain, and the moment any target has a balance, fire your `onDeposit`
   callback (e.g. an API call to your backend) and show a toast.
2. **`getBalances()`** — read the balance of every imported token + native coin
   across your targets in as few round-trips as possible (one **Multicall3**
   `eth_call` per EVM chain).

Both take an array of `{ address, tokenAddress, chainId }` targets. On top of
them the package also exports a **reusable watcher** (`createDepositWatcher()`,
for holding one configured instance) and **two React hooks**
(`useDepositWatch()`, `useBalances()`), plus a set of validation, formatting and
low-level RPC [utilities](#utilities).

**Contents:** [Install](#install) · [`watchDeposits()`](#function-1--watchdeposits-qr-modal) ·
[`getBalances()`](#function-2--getbalances-batched-balance-loop) ·
[Reusable watcher](#reusable-watcher--createdepositwatcher) · [React](#react) ·
[Validation](#address--token-validation) · [Target shape & chain ids](#the-target-shape) ·
[`WatchOptions` reference](#watchoptions-reference) ·
[`DepositWatchConfig` reference](#depositwatchconfig-reference) ·
[Localization](#localization-i18n) · [Theming](#theming--custom-css) ·
[Rate limits](#rate-limits--api-keys) · [Utilities](#utilities)

- 🧩 **Framework-agnostic core** — works in React, Vue, Svelte, vanilla JS, anywhere with a DOM.
- ⚛️ **First-class React hook** — `useDepositWatch()`.
- ⛓️ **EVM + Solana + Tron** — native coins, ERC-20, SPL, and TRC-20 tokens, mainnets **and testnets**.
- 🎨 **Self-contained modal** — Shadow DOM, so your app's CSS can't leak in and vice-versa. Light/dark/auto.
- 📡 **Public RPC defaults, fully overridable** — zero-config to start, bring your own endpoints for production.
- 📦 **Zero runtime dependencies** — the QR generator is bundled in; ESM + CJS + types. Loads directly in a browser or through any bundler.

## Install

```bash
npm install deposit-watch
```

## Function 1 — `watchDeposits()` (QR modal)

```ts
import { watchDeposits } from "deposit-watch";

const result = await watchDeposits(
  [
    { address: "0xYourReceivingAddr", tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", chainId: 1 }, // USDC on Ethereum
    { address: "0xYourReceivingAddr", chainId: 8453 },        // native ETH on Base
    { address: "YourSolanaAddr", chainId: "solana-mainnet" }, // native SOL
  ],
  {
    config: { title: "Fund your account", theme: "auto" },
    pollIntervalMs: 5000,
    // Fires the INSTANT a balance is detected. Return a Promise (an API call to
    // your backend) and the SDK awaits it before closing the modal.
    onDeposit: async (e) => {
      await fetch("/api/deposit-received", {
        method: "POST",
        body: JSON.stringify({ address: e.target.address, amount: e.deltaFormatted, raw: e.current.raw.toString() }),
      });
    },
  },
);

if (result.status === "funded") {
  console.log("Received:", result.event.deltaFormatted);
}
```

That single call renders the modal, shows a QR per target (tabs when there are
several), polls every 5s, and — by default — treats **any positive balance** as
a received deposit (great for fresh, single-use deposit addresses).

### Detection modes

- `detect: "positive"` **(default)** — any balance ≥ `minAmountRaw` (default `1n`)
  counts as a deposit. Because it doesn't compare against a baseline, the API
  call fires immediately even if funds are already sitting at the address.
  Intended for **unique per-user deposit addresses**.
- `detect: "increase"` — only fires when the balance rises above what it was when
  the modal opened. Use this for **reused addresses** that may already hold funds.

```ts
watchDeposits(targets, { detect: "positive", minAmountRaw: 1n });  // default
watchDeposits(targets, { detect: "increase" });                    // baseline diff
```

### Requiring a minimum amount (installments)

`minAmountRaw` is only the `"positive"`-mode **detection floor** — it fires the
instant the balance first crosses it. If instead you need a full amount to
_accumulate_ (possibly across several transfers) before the deposit counts as
complete, set **`minDepositRaw`**:

```ts
await watchDeposits(targets, {
  minDepositRaw: 100_000_000n, // e.g. 100 USDC (6 decimals) — total required
  onPartialDeposit: (e) => {
    // Fires each poll while the running total is still short. Not awaited.
    console.log(`So far ${e.deltaFormatted} — still waiting for the rest`);
  },
  onDeposit: (e) => {
    // Fires once, when the accumulated total finally reaches minDepositRaw.
    console.log(`Complete: ${e.deltaFormatted}`);
  },
});
```

- Works in **both** detect modes. The amount is measured as the delta over each
  target's baseline — the opening balance in `"increase"` mode, or `0` in
  `"positive"` mode — so multiple installments add up across polls.
- While the total is below the threshold the watcher keeps polling, surfaces
  progress in the modal, and calls `onPartialDeposit` (fire-and-forget — never
  awaited, so a slow handler can't stall the loop). It does **not** resolve or
  fire `onDeposit`.
- Leave it unset (the default) and any qualifying deposit completes immediately.

## Function 2 — `getBalances()` (batched balance loop)

Read every target's balance — imported tokens **and** native — in as few RPC
calls as possible. EVM targets on the same chain are batched into a single
**Multicall3** `eth_call` (native via `getEthBalance`, tokens via `balanceOf`
+ `decimals`). Solana / Tron targets fall back to individual (parallel) calls.
Results preserve input order.

```ts
import { getBalances } from "deposit-watch";

const balances = await getBalances([
  { address, chainId: 1 },                       // native ETH  ┐
  { address, tokenAddress: USDC, chainId: 1 },   // USDC        ├─ one multicall
  { address, tokenAddress: USDT, chainId: 1 },   // USDT        ┘
  { address, chainId: 8453 },                    // native ETH on Base (separate multicall)
  { address: solAddr, chainId: "solana-mainnet" }, // separate call
]);

for (const { target, balance } of balances) {
  console.log(target.chainId, target.tokenAddress ?? "native", balance.raw, balance.decimals);
}
```

Each entry is `{ target, balance: { raw: bigint, decimals?, symbol? } }`. Use
`formatUnits(balance.raw, balance.decimals)` to render.

> `getBalances()` never throws for a single failed target — an unreadable
> address comes back as `{ raw: 0n }` so one bad RPC can't sink the whole batch.
> It takes the same [`DepositWatchConfig`](#depositwatchconfig-reference) as the
> modal (second arg), so `rpcUrls`, `rpcHeaders`, `fetchFn` and `maxBatchSize`
> all apply here too.

## Reusable watcher — `createDepositWatcher()`

`watchDeposits()` is a one-shot convenience wrapper. Under the hood it builds a
watcher and calls `.open()` once. When you want to **configure once and reuse**
(same RPCs, theme and locale across many deposit flows), create the watcher
yourself and hold onto it:

```ts
import { createDepositWatcher } from "deposit-watch";

// Configure once — this is the DepositWatchConfig (see the reference below).
const watcher = createDepositWatcher({
  rpcUrls: { 1: "https://your-eth-rpc" },
  theme: "dark",
  locale: "es",
  title: "Acme Inc",
});

// Reuse for each flow. The second arg is the per-open WatchOptions.
const result = await watcher.open(targets, { pollIntervalMs: 4000, onDeposit });
```

`watcher.open(targets, options)` returns the same `Promise<DepositResolution>`
as `watchDeposits()`. Note the split: the **config** (RPCs / appearance / i18n)
is fixed at `createDepositWatcher()` time; the **options** (detection, polling,
callbacks) are passed per `.open()` call. `watchDeposits(targets, opts)` is
exactly `createDepositWatcher(opts.config).open(targets, restOfOpts)`.

Both entry points **require a browser DOM** and reject if given zero targets or
an [invalid address/token](#address--token-validation).

## React

Import from the `deposit-watch/react` entry point (React is an optional peer
dependency, `>=17`). Two hooks are exported.

### `useDepositWatch(config?)` — the modal

Takes a [`DepositWatchConfig`](#depositwatchconfig-reference) and returns
`open()` plus reactive state. The `config` is memoized by identity, so pass a
stable object or wrap it in `useMemo` if it holds dynamic values.

```tsx
import { useDepositWatch } from "deposit-watch/react";

function DepositButton({ address }: { address: string }) {
  const { open, isWatching, lastDeposit, lastPartial } = useDepositWatch({
    title: "Add funds",
  });

  return (
    <>
      <button
        disabled={isWatching}
        onClick={() =>
          open(
            [{ address, tokenAddress: null, chainId: 8453 }],
            { pollIntervalMs: 4000 }, // per-open WatchOptions (optional)
          )
        }
      >
        {isWatching ? "Waiting for deposit…" : "Deposit"}
      </button>
      {lastPartial && <p>Received {lastPartial.deltaFormatted} so far…</p>}
      {lastDeposit && <p>Received {lastDeposit.deltaFormatted}!</p>}
    </>
  );
}
```

The hook returns:

| Field         | Type                                                    | Notes                                                                                     |
| ------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `open`        | `(targets, options?) => Promise<DepositResolution>`     | Opens the modal. Throws if one is already open.                                           |
| `isWatching`  | `boolean`                                               | True while the modal is open and polling.                                                 |
| `lastResult`  | `DepositResolution \| null`                             | The most recent resolution (funded / all-funded / closed / timeout).                      |
| `lastDeposit` | `DepositEvent \| null`                                  | The most recent **completed** deposit, across sessions.                                   |
| `lastPartial` | `DepositEvent \| null`                                  | Latest partial (received but below `minDepositRaw`); resets to `null` once complete. Only set when `minDepositRaw` is used. |

### `useBalances(targets, config?)` — batched reads

Wraps [`getBalances()`](#function-2--getbalances-batched-balance-loop). Fetches
on mount and again whenever the **contents** of `targets` change (compared by
value, so a fresh array literal every render is fine — it won't refetch unless
something actually changed).

```tsx
import { useBalances } from "deposit-watch/react";

function Balances({ address }: { address: string }) {
  const { balances, isLoading, error, refresh } = useBalances([
    { address, chainId: 1 },                     // native ETH  ┐
    { address, tokenAddress: USDC, chainId: 1 }, // USDC        ├─ one multicall
    { address, tokenAddress: USDT, chainId: 1 }, // USDT        ┘
  ]);

  if (isLoading) return <p>Loading…</p>;
  if (error) return <p>Failed: {error.message}</p>;
  return (
    <ul>
      {balances?.map(({ target, balance }, i) => (
        <li key={i}>
          {target.tokenAddress ?? "native"}: {formatUnits(balance.raw, balance.decimals)}
        </li>
      ))}
      <button onClick={() => refresh()}>Refresh</button>
    </ul>
  );
}
```

| Field       | Type                                             | Notes                                                              |
| ----------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `balances`  | `BalanceResult[] \| null`                        | Latest read, in `targets` order; `null` before the first fetch.    |
| `isLoading` | `boolean`                                         | True while a read is in flight.                                    |
| `error`     | `Error \| null`                                   | Error from the last failed read.                                   |
| `refresh`   | `(targets?) => Promise<BalanceResult[]>`          | Manual/polled re-read. Reads the hook's `targets`, or an override. |

Poll by calling `refresh()` on an interval:

```tsx
useEffect(() => {
  const id = setInterval(() => refresh(), 10_000);
  return () => clearInterval(id);
}, [refresh]);
```

## Address & token validation

`watchDeposits()` **validates the receiving address _and_ the token
contract/mint before opening the modal** and rejects the promise if either is
malformed — so you never render a QR or poll a typo'd address/token. Validation
is chain-aware:

- **EVM** — `0x` + 40 hex; mixed-case must pass the **EIP-55 checksum**. Valid
  addresses are normalized to checksum form for the QR/display/reads.
- **Solana** — base58 decoding to a 32-byte key.
- **Tron** — base58check with the `0x41` prefix and a valid double-SHA-256 checksum.

Native-coin targets (no `tokenAddress`, or `"native"`/`"eth"`/`"sol"`/`"trx"`/the
zero address) skip the token check.

Use the same checks yourself (e.g. to validate form input):

```ts
import { validateAddress, validateTarget } from "deposit-watch";

// A single address:
const a = validateAddress(userInput, 1);          // { ok, normalized, error? }

// A whole target — checks address AND token (when present):
const v = validateTarget({ address, tokenAddress, chainId: 1 });
// { ok, address, tokenAddress, normalized: { address, tokenAddress }, errors: [] }
if (!v.ok) showErrors(v.errors);
```

## The target shape

```ts
interface DepositTarget {
  address: string;              // receiving address (0x… or base58)
  tokenAddress?: string | null; // omit/null = native coin; else ERC-20 or SPL mint
  chainId: number | string;     // EVM chain id (1, 137, 8453…) or "solana-mainnet"
  decimals?: number;            // optional; auto-read on-chain otherwise
  label?: string;               // optional tab label
}
```

**Chain ids**

| Value                | Chain            | Type    |
| -------------------- | ---------------- | ------- |
| `1`                  | Ethereum         | mainnet |
| `10`                 | Optimism         | mainnet |
| `56`                 | BNB Smart Chain  | mainnet |
| `137`                | Polygon          | mainnet |
| `8453`               | Base             | mainnet |
| `42161`              | Arbitrum One     | mainnet |
| `43114`              | Avalanche        | mainnet |
| `11155111`           | Ethereum Sepolia | testnet |
| `17000`              | Ethereum Holesky | testnet |
| `560048`             | Ethereum Hoodi   | testnet |
| `11155420`           | Optimism Sepolia | testnet |
| `97`                 | BNB Testnet      | testnet |
| `80002`              | Polygon Amoy     | testnet |
| `84532`              | Base Sepolia     | testnet |
| `421614`             | Arbitrum Sepolia | testnet |
| `43113`              | Avalanche Fuji   | testnet |
| `"solana-mainnet"`   | Solana           | mainnet |
| `"solana-devnet"`    | Solana devnet    | testnet |
| `"solana-testnet"`   | Solana testnet   | testnet |
| `"tron-mainnet"`     | Tron             | mainnet |
| `"tron-shasta"`      | Tron Shasta      | testnet |
| `"tron-nile"`        | Tron Nile        | testnet |

> **Tron uses TronGrid's Ethereum-compatible JSON-RPC** (`/jsonrpc`). Base58
> `T…` addresses are converted to `0x` hex internally, so Tron reuses the EVM
> read path (`eth_getBalance` for TRX, `eth_call` `balanceOf`/`decimals` for
> TRC-20). TronGrid's free tier is capped at **~3 req/s** — the fix is an API
> key (see [Rate limits & API keys](#rate-limits--api-keys)).
>
> **Multicall on Tron?** There's no Multicall3 contract deployed on Tron, but its
> JSON-RPC supports **batch requests**, so `getBalances()` reads all Tron targets
> for a chain in a single HTTP request — the same request-count win.

## `WatchOptions` reference

The second argument to `watchDeposits()` / `watcher.open()` / the hook's
`open()`. Every field is optional. (In `watchDeposits()`, `config` is nested
alongside these — see the [config reference](#depositwatchconfig-reference).)

```ts
watchDeposits(targets, {
  detect: "positive",     // "positive" (any balance) | "increase" (baseline diff)
  minAmountRaw: 1n,       // positive-mode detection floor, smallest units
  minDepositRaw: undefined, // require this much to ACCUMULATE before completing
  pollIntervalMs: 6000,   // default 6s
  timeoutMs: 15 * 60_000, // optional; resolves { status: "timeout" }
  resolveOn: "first",     // "first" (any target) | "all" (every target)
  autoClose: true,        // close the modal shortly after funding
  autoCloseDelayMs: 2500,
  onDeposit: async (event) => {},        // awaited if it returns a Promise
  onPartialDeposit: (event) => {},       // fire-and-forget; only with minDepositRaw
  onPoll: (snapshots) => {},             // Map<DepositTarget, BalanceSnapshot>
  onClose: () => {},
  config: { /* DepositWatchConfig — watchDeposits() only */ },
});
```

| Option             | Type                                       | Default      | What it does                                                                                              |
| ------------------ | ------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------- |
| `detect`           | `"positive" \| "increase"`                 | `"positive"` | `"positive"`: any balance ≥ `minAmountRaw` counts. `"increase"`: only a rise above the opening balance.  |
| `minAmountRaw`     | `bigint`                                   | `1n`         | `"positive"`-mode detection floor, per target, in smallest units. Fires on first crossing.               |
| `minDepositRaw`    | `bigint`                                   | _unset_      | Total that must **accumulate** (over baseline) before completing — supports [installments](#requiring-a-minimum-amount-installments). |
| `pollIntervalMs`   | `number`                                   | `6000`       | Milliseconds between balance polls.                                                                       |
| `timeoutMs`        | `number`                                   | _no timeout_ | Give up after this long → resolves `{ status: "timeout" }`.                                               |
| `resolveOn`        | `"first" \| "all"`                         | `"first"`    | Resolve on the first funded target, or once **every** target has funded.                                 |
| `autoClose`        | `boolean`                                  | `true`       | Auto-close the modal after resolution (so the user can read the toast).                                   |
| `autoCloseDelayMs` | `number`                                   | `2500`       | Delay before that auto-close.                                                                             |
| `onDeposit`        | `(e: DepositEvent) => void \| Promise`     | —            | Fires the moment a (complete) deposit is detected. **Awaited** before resolving/closing.                 |
| `onPartialDeposit` | `(e: DepositEvent) => void \| Promise`     | —            | Fires each poll while below `minDepositRaw`. **Not awaited**; errors are logged.                          |
| `onPoll`           | `(snaps: Map<Target, Snapshot>) => void`   | —            | Every poll cycle, with the latest snapshots. Debug/telemetry.                                             |
| `onClose`          | `() => void`                               | —            | Fires when the user dismisses the modal.                                                                  |

### The `DepositEvent` passed to callbacks

```ts
interface DepositEvent {
  target: DepositTarget;
  previous: BalanceSnapshot;   // balance before (or baseline)
  current: BalanceSnapshot;    // balance after — { raw, decimals?, symbol? }
  deltaRaw: bigint;            // current.raw - previous.raw (amount received)
  deltaFormatted: string;      // human string, e.g. "12.5"
}
```

## `DepositWatchConfig` reference

Passed to `createDepositWatcher(config)` / `watchDeposits(targets, { config })`
/ the React hooks. Covers RPC endpoints, appearance and i18n. Every field is
optional — the SDK is zero-config to start.

```ts
{
  // ── RPC / network ──
  rpcUrls: { 1: "https://your-eth-rpc", "solana-mainnet": "https://your-sol-rpc" },
  rpcHeaders: { "tron-mainnet": { "TRON-PRO-API-KEY": "<key>" } }, // per-chain headers (API keys)
  fetchFn: fetch,        // custom fetch (SSR / proxy / custom agent)
  maxBatchSize: undefined, // cap targets per batched request (see below)

  // ── Appearance ──
  theme: "auto",          // "light" | "dark" | "auto"
  title: "Acme Inc",      // modal header — your company / brand name
  subtitle: "Fund your account", // line under it; localized default, "" / null to hide
  accent: "#5b5bd6",      // shortcut for tokens.accent
  tokens: { accent: "#ff5a1f", radius: "8px", bg: "#0b0b0f" }, // design-token restyle
  css: ".dw-card { border-radius: 0 }", // raw CSS escape hatch (shadow root)

  // ── Localization ──
  locale: "es",           // built-in: en·es·fr·de·pt·zh·ja·ru (region subtags fall back)
  messages: { waiting: "Send funds to this address…" }, // override individual strings
}
```

| Field          | Type                                             | Default    | What it does                                                                                         |
| -------------- | ------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------------- |
| `rpcUrls`      | `Record<ChainId, string>`                        | public RPCs | Override/extend the [built-in endpoints](#rate-limits--api-keys), keyed by chain id.                |
| `rpcHeaders`   | `Record<ChainId, Record<string, string>>`        | —          | Per-chain HTTP headers, typically API keys. The fix for TronGrid rate limits.                       |
| `fetchFn`      | `typeof fetch`                                    | global `fetch` | Custom fetch implementation (SSR, proxying, auth).                                              |
| `maxBatchSize` | `number`                                          | no limit   | Max **targets** per batched request (Multicall3 / JSON-RPC batch). See below.                        |
| `theme`        | `"light" \| "dark" \| "auto"`                    | `"auto"`   | Color scheme; `"auto"` follows `prefers-color-scheme`.                                               |
| `title`        | `string`                                          | `"Deposit"` | Modal header — your brand name. Overrides `messages.title`.                                         |
| `subtitle`     | `string \| null`                                  | localized  | Small line under the header. `""` / `null` hides it. See [i18n](#localization-i18n).                |
| `accent`       | `string` (CSS color)                              | indigo     | Accent color shortcut — equivalent to `tokens.accent`.                                               |
| `tokens`       | `Partial<ThemeTokens>`                            | —          | Restyle via [design tokens](#theming--custom-css) — the whole modal re-themes consistently.         |
| `css`          | `string`                                          | —          | Raw CSS appended inside the shadow root — the full escape hatch.                                     |
| `locale`       | `string`                                          | `"en"`     | Built-in locale for modal strings. See [Localization](#localization-i18n).                           |
| `messages`     | `Partial<Messages>`                               | —          | Override individual UI strings, layered on top of `locale`.                                          |

### `maxBatchSize` — capping request size

By default every target on a chain goes into **one** batched request. If a
provider caps JSON-RPC batch length, or a huge Multicall3 call exceeds the
`eth_call` gas ceiling, set `maxBatchSize` to split each chain's group into
several requests that run in parallel and are reassembled in order:

```ts
config: { maxBatchSize: 25 }
```

It counts **targets, not sub-calls**: a token target whose `decimals` is unknown
costs two sub-calls (`balanceOf` + `decimals`), so a request may hold up to
`2 × maxBatchSize` sub-calls. Values `< 1` or non-finite mean "no limit".

### Resolution

`open()` / `watchDeposits()` resolves with one of:

```ts
{ status: "funded"; event: DepositEvent }        // resolveOn: "first"
{ status: "all-funded"; events: DepositEvent[] } // resolveOn: "all"
{ status: "closed" }                             // user dismissed
{ status: "timeout" }                            // timeoutMs elapsed
```

## Localization (i18n)

Every user-facing string in the modal is localizable. Pick a built-in locale, or
override individual strings — or both (overrides layer on top of the locale).

```ts
watchDeposits(targets, { config: { locale: "ja" } });          // built-in Japanese
watchDeposits(targets, { config: {
  locale: "es",
  messages: { title: "Añadir fondos", waiting: "Envía a esta dirección…" },
} });
```

The modal header is your **company name** (`config.title`); the small line under
it is the localized **"Fund your account"** (`messages.subtitle`), which follows
the chosen `locale` automatically:

```ts
watchDeposits(targets, { config: {
  title: "Acme Inc",   // header = your brand
  locale: "de",         // subtitle auto-renders "Laden Sie Ihr Konto auf"
  // subtitle: "Add funds to get started",  // …or set your own
  // subtitle: "",                          // …or hide the line
} });
```

Built-in locales: `en` (default), `es`, `fr`, `de`, `pt`, `zh`, `ja`, `ru`.
Region subtags fall back to the base language (`"pt-BR"` → `"pt"`); unknown codes
fall back to English. Parameterized strings use `{name}` placeholders:

```ts
messages: {
  token: "token {address}",
  partial: "Received {received} of {required}{symbol} — waiting for the rest…",
  toastReceived: "Received {amount}{symbol} at {address} ✅",
}
```

Add your own language by supplying a full `messages` object (see the `Messages`
type). `resolveMessages(locale, overrides)` and the `LOCALES` map are exported if
you want to compose dictionaries yourself.

## Theming & custom CSS

The modal renders in a shadow root, so it's isolated from your page's styles.
Three levels of control, cheapest first:

```ts
// 1. Accent shortcut
config: { accent: "#ff5a1f" }

// 2. Design tokens — recolor/re-measure the whole modal consistently.
//    The full ThemeTokens set (partial is fine — unset tokens keep their theme default):
config: { tokens: {
  accent: "#ff5a1f", accentText: "#fff",   // active tab / spinner / copy button
  bg: "#0b0b0f", fg: "#f5f5f7", sub: "#9aa0aa", // card bg, primary + muted text
  border: "#232630", chip: "#181b22",      // hairlines; chip / address pill fill
  overlay: "rgba(0,0,0,.7)",               // scrim behind the card
  success: "#16a34a", error: "#dc2626",    // received / timeout states
  toastBg: "#0f1115", toastFg: "#fff",     // toast colors
  radius: "8px",                           // card corner radius
  fontFamily: "Inter, sans-serif",         // modal chrome font
  monoFontFamily: "ui-monospace, Menlo, monospace", // address pill font
} }

// 3. Raw CSS — the full escape hatch, appended inside the shadow root
config: { css: `
  .dw-card { border-radius: 0; box-shadow: none; }
  .dw-title { text-transform: uppercase; letter-spacing: .08em; }
  .dw-tab[data-active="true"] { background: linear-gradient(90deg,#ff5a1f,#ff008a); }
` }
```

Every token is exposed as a CSS custom property (`--dw-accent`, `--dw-bg`,
`--dw-radius`, …) on `:host`, so your `css` can also just redefine variables.
Class names are stable (`.dw-overlay`, `.dw-card`, `.dw-head`, `.dw-head-text`,
`.dw-title`, `.dw-subtitle`, `.dw-x`, `.dw-tabs`, `.dw-tab`, `.dw-body`,
`.dw-qr`, `.dw-meta`, `.dw-addr`, `.dw-copy`, `.dw-status`, `.dw-spinner`,
`.dw-toast`).

## How balance detection works

Every poll, the SDK reads each target's raw integer balance. In `"positive"` mode
(default) a balance ≥ `minAmountRaw` fires a `DepositEvent` immediately; in
`"increase"` mode it establishes a baseline on open (a failed initial read never
counts) and fires only when the balance rises above it. Either way the event
carries `deltaRaw` (bigint) and a formatted `deltaFormatted`, and `onDeposit` is
awaited before the modal closes.

Per-chain balance reads: EVM uses `eth_getBalance` (native) and ERC-20 `balanceOf`
+ `decimals` + `symbol`; Solana uses `getBalance` (native) and
`getTokenAccountsByOwner` summed across accounts (SPL); Tron uses the TronGrid
account API (native TRX + TRC-20). `getBalances()` batches EVM reads through
Multicall3.

> **Note on RPCs.** The bundled endpoints are shared public nodes for convenience —
> rate-limited and not for production traffic. Pass your own via `config.rpcUrls`.

## Rate limits & API keys

The bundled public endpoints (EVM `publicnode`, Solana, TronGrid) are shared and
rate-limited. TronGrid's free tier is especially tight (**~3 req/s**), so heavy
polling will hit `429`. Two levers, use both:

1. **Send an API key** via `rpcHeaders` (keyed by chain):

   ```ts
   watchDeposits(targets, {
     config: { rpcHeaders: { "tron-mainnet": { "TRON-PRO-API-KEY": "<key>" } } },
   });
   ```

2. **Make fewer requests** — `getBalances()` already batches (Multicall3 on EVM,
   JSON-RPC batch on Tron) so many balances cost one HTTP request. For the modal,
   raise `pollIntervalMs`.

You can also point `rpcUrls` at your own dedicated nodes.

## Utilities

Everything the modal and batching use internally is exported for direct use.

### Balance reads

```ts
import { getBalance, getBalances } from "deposit-watch";

// One target — native or token — with any DepositWatchConfig (rpcUrls, headers…).
const snap = await getBalance({ address, tokenAddress, chainId: 1 }, { rpcUrls });
// → { raw: bigint, decimals?, symbol? }
```

- `getBalance(target, config?)` — read a single target.
- `getBalances(targets, config?)` — batched multi-target read (see [Function 2](#function-2--getbalances-batched-balance-loop)).

### Formatting & display

```ts
import { formatUnits, shortenAddress, qrSvg } from "deposit-watch";

formatUnits(12500000n, 6);        // "12.5"  (raw → human, decimals-aware)
shortenAddress("0x1234…", 6, 4);  // "0x1234…abcd"
qrSvg("ethereum:0x…");            // string of <svg> markup for any payload
```

### Validation (chain-aware)

```ts
import {
  validateAddress, validateTarget,   // high-level (see the Validation section)
  isValidEvmAddress, isValidSolanaAddress, isValidTronAddress,
  toChecksumAddress,                 // EVM → EIP-55 checksum form
  isNativeTokenRef,                  // true for null/"native"/"eth"/"sol"/"trx"/zero-addr
  tronBase58ToEvmHex, base58Decode,  // Tron/base58 primitives
} from "deposit-watch";
```

### Localization & theming helpers

```ts
import {
  LOCALES, DEFAULT_LOCALE, resolveMessages, // i18n dictionaries (see Localization)
  defaultTokens, resolveTokens,             // ThemeTokens for light/dark
} from "deposit-watch";

resolveMessages("es", { title: "Añadir fondos" }); // full Messages, overrides layered on
defaultTokens(/* dark */ true);                     // the built-in dark palette
```

### Low-level RPC / Multicall

```ts
import {
  DEFAULT_RPC_URLS,          // the built-in public endpoint map
  getEvmBalancesMulticall,   // Multicall3 read for a set of EVM targets on one chain
  encodeAggregate3, decodeAggregate3, MULTICALL3_ADDRESS, // Multicall3 ABI primitives
} from "deposit-watch";
```

`createDepositWatcher` and both React hooks are also re-exported from
`deposit-watch/react` for convenience.

## Try the demo

```bash
npm install && npm run build
npx serve .          # serve the PROJECT ROOT, not examples/
```

Then open **http://localhost:3000/examples/demo.html**.

> Serve the repo root, because the demo loads the built SDK from `../dist/`. If
> you serve `examples/` as the root instead, that `../dist` path escapes the web
> root and you'll get `GET /dist/index.js 404`.

## License

MIT
