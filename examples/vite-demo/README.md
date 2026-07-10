# deposit-watch — Vite + React demo

A minimal Vite app that showcases the `useDepositWatch` React hook on localhost,
including `minDepositRaw` (installment / minimum-amount deposits) and the
`lastPartial` progress state.

## Run it

The demo consumes the SDK from this repo via `"deposit-watch": "file:../.."`,
which resolves to the package's built `dist/`. So **build the SDK first**, then
start the app:

```bash
# 1. from the repo root — build the SDK (produces dist/)
cd ../..
npm install
npm run build

# 2. run this demo
cd examples/vite-demo
npm install
npm run dev
```

Open the printed URL (default http://localhost:5173).

> If you change SDK source afterwards, re-run `npm run build` in the repo root.
> Vite serves the built `dist/`, not the TypeScript source.

## Try it

1. Paste a **real receiving address** you control and pick its **chain**.
2. (Optional) Enter a **token address** — blank watches the native coin.
3. (Optional) Set a **min deposit** in raw units (e.g. `5000000` = 5 USDC at
   6 decimals). The modal keeps polling and shows partial progress until the
   running total reaches it — so a payment can arrive in installments.
4. Click **Open deposit modal** and send funds. Watch the log update via
   `onPartialDeposit` → `onDeposit`.

## What it demonstrates

- `useDepositWatch(config)` → `{ open, isWatching, lastDeposit, lastPartial, lastResult }`
- `minDepositRaw` — accumulate installments before completing
- `onPartialDeposit` / `onDeposit` hooks (the latter is awaited before the modal closes)
- `detect: "positive" | "increase"` modes
- `useBalances(targets)` → `{ balances, isLoading, error, refresh }` — batched
  native + multi-token reads (one Multicall3 call per EVM chain)
