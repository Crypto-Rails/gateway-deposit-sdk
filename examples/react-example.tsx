/**
 * React usage example for `deposit-watch`.
 *
 * Demonstrates the `useDepositWatch` hook end-to-end:
 *   • opening the QR deposit modal for a target
 *   • `minDepositRaw` — require a minimum amount, letting a payment arrive in
 *     several installments before it completes
 *   • `lastPartial` — live progress while the running total is still short
 *   • `onDeposit` — an awaited backend call the instant the deposit completes
 *   • i18n + theming — pick a built-in `locale`, override strings via `messages`,
 *     recolor with `tokens`, or inject raw `css` (see `LocalizedThemedDeposit`)
 *
 * Run inside any React 17+ app. Install the package first:
 *   npm i deposit-watch react
 *
 * This file imports from the published entry point ("deposit-watch/react").
 * When hacking on the SDK locally, swap the import for "../dist/react/index.js".
 */
import { useMemo, useState } from "react";
import {
  useDepositWatch,
  LOCALES,
  type DepositResolution,
  type DepositWatchConfig,
} from "deposit-watch/react";

// USDC on Base — 6 decimals. Amounts are raw (smallest-unit) bigints throughout.
const USDC_BASE = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_DECIMALS = 6;
const usdc = (whole: number) => BigInt(Math.round(whole * 10 ** USDC_DECIMALS));

export function DepositButton({ receivingAddress }: { receivingAddress: string }) {
  // The config object is memoized by identity inside the hook, so define it once
  // (module scope or useMemo) if it holds dynamic values. A literal is fine here.
  const { open, isWatching, lastDeposit, lastPartial, lastResult } = useDepositWatch({
    title: "Add funds",
    theme: "auto",
    // Production tip: pass your own RPCs / API keys rather than the public defaults.
    // rpcUrls: { 8453: "https://base-mainnet.g.alchemy.com/v2/<key>" },
  });

  const [status, setStatus] = useState<string>("");

  async function handleDeposit() {
    setStatus("Waiting for a deposit of at least 10 USDC…");

    const result: DepositResolution = await open(
      [{ address: receivingAddress, tokenAddress: USDC_BASE, chainId: 8453, decimals: USDC_DECIMALS }],
      {
        // Require 10 USDC total before completing. A user can pay 4 + 6 and it
        // only fires onDeposit once the running total reaches the threshold.
        minDepositRaw: usdc(10),

        // Fires on every poll while the amount received is still under 10 USDC.
        // Great for recording partial payments on your backend.
        onPartialDeposit: (e) => {
          setStatus(`Partial: ${e.deltaFormatted} / 10 USDC received…`);
        },

        // Fires once — when the total is finally enough. Awaited before the modal
        // auto-closes, so your backend is up to date by the time open() resolves.
        onDeposit: async (e) => {
          await fetch("/api/deposit-received", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              address: e.target.address,
              chainId: e.target.chainId,
              amount: e.deltaFormatted, // "10" (or more, if they overpaid)
              raw: e.current.raw.toString(), // bigint → string for JSON
            }),
          });
        },
      },
    );

    if (result.status === "funded") setStatus(`✅ Funded with ${result.event.deltaFormatted} USDC`);
    else if (result.status === "closed") setStatus("Modal closed.");
    else if (result.status === "timeout") setStatus("Timed out waiting for a deposit.");
  }

  return (
    <div>
      <button onClick={handleDeposit} disabled={isWatching}>
        {isWatching ? "Waiting for deposit…" : "Deposit 10 USDC"}
      </button>

      {/* Live installment progress, driven by the hook's `lastPartial` state. */}
      {lastPartial && !lastDeposit && (
        <p>
          Received so far: <strong>{lastPartial.deltaFormatted}</strong> USDC — waiting for the rest…
        </p>
      )}

      {status && <p>{status}</p>}

      {lastDeposit && (
        <pre>
          {JSON.stringify(
            { amount: lastDeposit.deltaFormatted, symbol: lastDeposit.current.symbol },
            null,
            2,
          )}
        </pre>
      )}

      {lastResult && <small>last session: {lastResult.status}</small>}
    </div>
  );
}

/**
 * Multi-chain variant: offer the user several addresses to choose from and
 * resolve as soon as ANY one is funded (resolveOn defaults to "first").
 */
export function MultiChainDeposit(props: { evm: string; solana: string; tron: string }) {
  const { open, isWatching } = useDepositWatch({ title: "Choose a network" });

  return (
    <button
      disabled={isWatching}
      onClick={() =>
        open([
          { address: props.evm, tokenAddress: USDC_BASE, chainId: 8453, label: "USDC · Base" },
          { address: props.solana, chainId: "solana-mainnet", label: "SOL · Solana" },
          { address: props.tron, chainId: "tron-mainnet", label: "TRX · Tron" },
        ])
      }
    >
      Fund any network
    </button>
  );
}

// Human-readable names for the SDK's built-in locales, for the picker below.
const LOCALE_NAMES: Record<string, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  zh: "中文",
  ja: "日本語",
  ru: "Русский",
};

/**
 * i18n + theming example. Lets the user pick a language and accent color, tweak
 * the corner radius, and (optionally) override the "waiting" string — then opens
 * the modal fully localized and restyled.
 *
 * Key idea: `useDepositWatch` memoizes `config` by identity, so build it with
 * `useMemo` keyed on the dynamic values. That's exactly how you'd wire a real
 * app's language/theme context into the deposit modal.
 */
export function LocalizedThemedDeposit({ receivingAddress }: { receivingAddress: string }) {
  const [company, setCompany] = useState("Acme Inc");
  const [locale, setLocale] = useState("en");
  const [accent, setAccent] = useState("#5b5bd6");
  const [radius, setRadius] = useState(18);
  const [waiting, setWaiting] = useState("");

  const config = useMemo<DepositWatchConfig>(
    () => ({
      // Your company name is the header. The small line under it is the localized
      // "Fund your account" (messages.subtitle) for the chosen locale — pass
      // `subtitle` to override it, or `subtitle: ""` to hide it.
      title: company || undefined,
      theme: "auto",
      locale, // built-in language: en·es·fr·de·pt·zh·ja·ru
      tokens: {
        accent, // design-token override — re-themes the whole modal
        radius: `${radius}px`,
      },
      // Raw CSS escape hatch — appended inside the modal's shadow root, so you
      // can override any `.dw-*` rule or `--dw-*` variable.
      css: `.dw-title { letter-spacing: -0.02em; }`,
      // Override a single string on top of the chosen locale (blank = default).
      messages: waiting ? { waiting } : undefined,
    }),
    [company, locale, accent, radius, waiting],
  );

  const { open, isWatching } = useDepositWatch(config);

  return (
    <div style={{ display: "grid", gap: 10, maxWidth: 360 }}>
      <label>
        Company name{" "}
        <input
          value={company}
          placeholder="e.g. Acme Inc"
          onChange={(e) => setCompany(e.target.value)}
        />
      </label>

      <label>
        Language{" "}
        <select value={locale} onChange={(e) => setLocale(e.target.value)}>
          {Object.keys(LOCALES).map((code) => (
            <option key={code} value={code}>
              {LOCALE_NAMES[code] ?? code} ({code})
            </option>
          ))}
        </select>
      </label>

      <label>
        Accent{" "}
        <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
      </label>

      <label>
        Corner radius: {radius}px{" "}
        <input
          type="range"
          min={0}
          max={28}
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
        />
      </label>

      <label>
        Override “waiting” text{" "}
        <input
          value={waiting}
          placeholder="(locale default)"
          onChange={(e) => setWaiting(e.target.value)}
        />
      </label>

      <button
        disabled={isWatching}
        onClick={() => open([{ address: receivingAddress, tokenAddress: USDC_BASE, chainId: 8453 }])}
      >
        {isWatching ? "Waiting for deposit…" : "Open localized modal"}
      </button>
    </div>
  );
}
