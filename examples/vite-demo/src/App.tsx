import { useMemo, useState } from "react";
import {
  useBalances,
  useDepositWatch,
  type ChainId,
  type DepositResolution,
} from "deposit-watch/react";
import { formatUnits } from "deposit-watch";

const CHAINS: { id: ChainId; label: string }[] = [
  { id: 1, label: "Ethereum" },
  { id: 56, label: "Binance Smart Chain" },
  { id: 8453, label: "Base" },
  { id: 137, label: "Polygon" },
  { id: 42161, label: "Arbitrum" },
  { id: 84532, label: "Base Sepolia" },
  { id: "solana-mainnet", label: "Solana" },
  { id: "tron-mainnet", label: "Tron" },
];

// Built-in locales shipped with the SDK — drives the modal's language.
const LOCALE_OPTIONS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Português" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
  { code: "ru", label: "Русский" },
];

/** One editable target row (address + token + chain) shared by both editors. */
type TargetRow = { address: string; token: string; chainIdx: number };

// Resolve a chain to its position in CHAINS (falls back to 0 if not listed), so
// seed rows stay correct no matter how CHAINS is ordered.
const chainIdxOf = (id: ChainId) =>
  Math.max(
    0,
    CHAINS.findIndex((c) => c.id === id),
  );

export function App() {
  // watchDeposits() / open() take an ARRAY of receiving targets. Each row is one
  // target (address + token + chain); the modal shows a tab per target. Whether
  // it resolves on the FIRST funded target or waits for ALL of them is the
  // `resolveOn` option below. Start with one row; add more to watch several
  // addresses / chains at once.
  const [watchRows, setWatchRows] = useState<TargetRow[]>([
    { address: "", token: "", chainIdx: chainIdxOf(8453) }, // default Base
  ]);
  const [detect, setDetect] = useState<"positive" | "increase">("positive");
  // "first" = resolve as soon as any target funds; "all" = wait for every one.
  const [resolveOn, setResolveOn] = useState<"first" | "all">("first");
  const [minDeposit, setMinDeposit] = useState(""); // raw units, blank = off
  const [company, setCompany] = useState("Acme Inc"); // modal title (your brand)
  const [locale, setLocale] = useState("en"); // modal language
  const [accent, setAccent] = useState("#5b5bd6"); // modal accent color
  const [log, setLog] = useState<string[]>([]);

  // The hook memoizes `config` by identity, so build it with useMemo and let it
  // change only when the user edits the brand / language / accent.
  const config = useMemo(
    () => ({
      // Your company name is the header; the small line under it is the localized
      title: company || undefined,
      theme: "auto" as const,
      locale,
      tokens: { accent },
      // Raw CSS escape hatch — tweak any `.dw-*` rule inside the shadow root.
      css: ".dw-card { border-radius: 12px; }",
    }),
    [company, locale, accent],
  );
  const { open, isWatching, lastDeposit, lastPartial, lastResult } =
    useDepositWatch(config);

  const addLog = (line: string) => setLog((l) => [line, ...l].slice(0, 12));

  const updateWatchRow = (i: number, patch: Partial<TargetRow>) =>
    setWatchRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addWatchRow = () =>
    setWatchRows((rs) => [
      ...rs,
      { address: "", token: "", chainIdx: rs[rs.length - 1]?.chainIdx ?? 0 },
    ]);
  const removeWatchRow = (i: number) =>
    setWatchRows((rs) => rs.filter((_, j) => j !== i));

  async function handleOpen() {
    const targets = watchRows
      .filter((r) => r.address.trim())
      .map((r) => ({
        address: r.address.trim(),
        tokenAddress: r.token.trim() || null,
        chainId: CHAINS[r.chainIdx]!.id,
      }));

    if (targets.length === 0) {
      addLog("✗ Add at least one receiving address.");
      return;
    }

    let minDepositRaw: bigint | undefined;
    if (minDeposit.trim()) {
      try {
        minDepositRaw = BigInt(minDeposit.trim());
      } catch {
        addLog("✗ Min deposit must be a whole number (raw / smallest units).");
        return;
      }
    }

    setLog([]);
    try {
      const result: DepositResolution = await open(targets, {
        detect,
        resolveOn,
        minDepositRaw,
        pollIntervalMs: 5000,
        // Fires each poll while the running total is still below minDepositRaw.
        onPartialDeposit: (e) =>
          addLog(`↻ partial — ${e.deltaFormatted} received so far…`),
        // Fires once, when the deposit is complete. Awaited before the modal closes.
        onDeposit: async (e) => {
          addLog(
            `→ POST /api/deposit-received  { amount: ${e.deltaFormatted} }`,
          );
          await new Promise((r) => setTimeout(r, 600)); // simulated backend call
          addLog("✓ backend acknowledged");
        },
      });

      addLog(`resolved: ${result.status}`);
    } catch (err) {
      addLog("✗ " + (err as Error).message);
    }
  }

  return (
    <main style={S.page}>
      <h1 style={S.h1}>deposit-watch — React demo</h1>
      <p style={S.hint}>
        A thin React wrapper (<code>useDepositWatch</code>) around the deposit
        SDK. Fill in <strong>one or more</strong> receiving targets, pick a
        chain for each, optionally set a <strong>min deposit</strong>, then open
        the modal and send funds to watch it detect the deposit live.
      </p>

      <div style={S.card}>
        <label style={S.label}>
          Receiving targets — <code>open()</code> takes an array
        </label>
        <p style={S.hint}>
          Each row is one receiving target (address · token · chain). Add
          several to watch multiple addresses / chains at once — the modal shows
          a tab per target and resolves as soon as <strong>any</strong> of them
          is funded.
        </p>

        {watchRows.map((r, i) => (
          <div key={i} style={S.targetRow}>
            <input
              style={{ ...S.input, flex: 2 }}
              value={r.address}
              onChange={(e) => updateWatchRow(i, { address: e.target.value })}
              placeholder="address — 0x… / base58 / T…"
            />
            <input
              style={{ ...S.input, flex: 2 }}
              value={r.token}
              onChange={(e) => updateWatchRow(i, { token: e.target.value })}
              placeholder="token (blank = native)"
            />
            <select
              style={{ ...S.input, flex: 1 }}
              value={r.chainIdx}
              onChange={(e) =>
                updateWatchRow(i, { chainIdx: Number(e.target.value) })
              }>
              {CHAINS.map((c, j) => (
                <option key={String(c.id)} value={j}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              style={S.removeBtn}
              onClick={() => removeWatchRow(i)}
              disabled={watchRows.length === 1}
              title="Remove target"
              aria-label="Remove target">
              ×
            </button>
          </div>
        ))}

        <button style={S.addBtn} onClick={addWatchRow}>
          + Add target
        </button>

        <div style={S.row}>
          <div style={S.col}>
            <label style={S.label}>Detection</label>
            <select
              style={S.input}
              value={detect}
              onChange={(e) =>
                setDetect(e.target.value as "positive" | "increase")
              }>
              <option value="positive">positive (any balance)</option>
              <option value="increase">increase (baseline diff)</option>
            </select>
          </div>
          <div style={S.col}>
            <label style={S.label}>Resolve on (multi-target)</label>
            <select
              style={S.input}
              value={resolveOn}
              onChange={(e) => setResolveOn(e.target.value as "first" | "all")}>
              <option value="first">first (any one target funds)</option>
              <option value="all">all (every target must fund)</option>
            </select>
          </div>
          <div style={S.col}>
            <label style={S.label}>Min deposit (raw units, blank = off)</label>
            <input
              style={S.input}
              value={minDeposit}
              onChange={(e) => setMinDeposit(e.target.value)}
              placeholder="e.g. 5000000 = 5 USDC"
            />
          </div>
        </div>

        <label style={S.label}>Company name (modal title)</label>
        <input
          style={S.input}
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          placeholder="e.g. Acme Inc"
        />

        <div style={S.row}>
          <div style={S.col}>
            <label style={S.label}>Modal language (i18n)</label>
            <select
              style={S.input}
              value={locale}
              onChange={(e) => setLocale(e.target.value)}>
              {LOCALE_OPTIONS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label} ({l.code})
                </option>
              ))}
            </select>
          </div>
          <div style={S.col}>
            <label style={S.label}>Accent color (theme token)</label>
            <input
              type="color"
              style={{ ...S.input, height: 40, padding: 4 }}
              value={accent}
              onChange={(e) => setAccent(e.target.value)}
            />
          </div>
        </div>

        <button
          style={{ ...S.button, ...(isWatching ? S.buttonDisabled : {}) }}
          onClick={handleOpen}
          disabled={isWatching}>
          {isWatching ? "Waiting for deposit…" : "Open deposit modal"}
        </button>

        {/* Live installment progress from the hook's `lastPartial` state. */}
        {lastPartial && !lastDeposit && (
          <p style={S.partial}>
            Received so far: <strong>{lastPartial.deltaFormatted}</strong> —
            waiting for the rest…
          </p>
        )}
      </div>

      <div style={S.card}>
        <label style={S.label}>onDeposit / onPartialDeposit log</label>
        <pre style={S.pre}>{log.length ? log.join("\n") : "(waiting…)"}</pre>

        <div style={S.stateRow}>
          <span>
            <strong>isWatching:</strong> {String(isWatching)}
          </span>
          <span>
            <strong>lastResult:</strong> {lastResult?.status ?? "—"}
          </span>
          <span>
            <strong>lastDeposit:</strong>{" "}
            {lastDeposit
              ? `${lastDeposit.deltaFormatted} ${lastDeposit.current.symbol ?? ""}`
              : "—"}
          </span>
        </div>
      </div>

      <BalancesCard />
    </main>
  );
}

// Seed the editor with a mixed target list — the whole point of getBalances is
// that a single call can span several addresses, tokens, native coins, and even
// chains. Here: one address' native ETH + USDC + USDT on Ethereum, plus a second
// address' native ETH on Base. Add / remove rows to build any mix you like.
const SEED_ROWS: TargetRow[] = [
  {
    address: "0x55FE002aefF02F77364de339a1292923A15844B8",
    token: "",
    chainIdx: chainIdxOf(1),
  }, // native ETH on Ethereum
  {
    address: "0x55FE002aefF02F77364de339a1292923A15844B8",
    token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    chainIdx: chainIdxOf(1),
  }, // USDC on Ethereum
  {
    address: "0x55FE002aefF02F77364de339a1292923A15844B8",
    token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    chainIdx: chainIdxOf(1),
  }, // USDT on Ethereum
  {
    address: "0x28C6c06298d514Db089934071355E5743bf21d60",
    token: "",
    chainIdx: chainIdxOf(8453),
  }, // native ETH on Base
];

const shortAddr = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
const chainLabel = (id: ChainId) =>
  CHAINS.find((c) => c.id === id)?.label ?? String(id);

/**
 * Batched balance reads via the `useBalances` hook. Each row is an independent
 * target — its own address, token (blank = native), and chain — so a single
 * `getBalances` call fans out across addresses, tokens, and chains. The SDK
 * groups EVM targets by chain into one Multicall3 call each, and returns results
 * in the SAME order as the targets. Typing does nothing; clicking "Fetch" commits
 * the rows and the hook auto-reads them (and re-reads on change).
 */
function BalancesCard() {
  const [rows, setRows] = useState<TargetRow[]>(SEED_ROWS);
  const [committed, setCommitted] = useState<TargetRow[] | null>(null);

  // Build the target list only from *committed* rows, so keystrokes don't refetch.
  const targets = useMemo(() => {
    if (!committed) return [];
    return committed
      .filter((r) => r.address.trim())
      .map((r) => ({
        address: r.address.trim(),
        // decimals: 18,
        tokenAddress: r.token.trim() || null, // blank → native coin
        chainId: CHAINS[r.chainIdx]!.id,
      }));
  }, [committed]);

  const { balances, isLoading, error, refresh } = useBalances(targets);

  const updateRow = (i: number, patch: Partial<TargetRow>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const addRow = () =>
    setRows((rs) => [
      ...rs,
      {
        address: rs[rs.length - 1]?.address ?? "",
        token: "",
        chainIdx: rs[rs.length - 1]?.chainIdx ?? 0,
      },
    ]);
  const removeRow = (i: number) =>
    setRows((rs) => rs.filter((_, j) => j !== i));

  return (
    <div style={S.card}>
      <h2 style={S.h2}>Batched balances — useBalances()</h2>
      <p style={S.hint}>
        Pass any mix of <strong>addresses, tokens, and native coins</strong> —
        even across chains — as one target list. The SDK reads them in as few
        round-trips as possible (EVM targets on the same chain share one
        Multicall3 call) and returns them in the same order.
      </p>

      {rows.map((r, i) => (
        <div key={i} style={S.targetRow}>
          <input
            style={{ ...S.input, flex: 2 }}
            value={r.address}
            onChange={(e) => updateRow(i, { address: e.target.value })}
            placeholder="address — 0x… / base58 / T…"
          />
          <input
            style={{ ...S.input, flex: 2 }}
            value={r.token}
            onChange={(e) => updateRow(i, { token: e.target.value })}
            placeholder="token (blank = native)"
          />
          <select
            style={{ ...S.input, flex: 1 }}
            value={r.chainIdx}
            onChange={(e) =>
              updateRow(i, { chainIdx: Number(e.target.value) })
            }>
            {CHAINS.map((c, j) => (
              <option key={String(c.id)} value={j}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            style={S.removeBtn}
            onClick={() => removeRow(i)}
            disabled={rows.length === 1}
            title="Remove target"
            aria-label="Remove target">
            ×
          </button>
        </div>
      ))}

      <button style={S.addBtn} onClick={addRow}>
        + Add target
      </button>

      <div style={{ display: "flex", gap: 10 }}>
        <button style={S.button} onClick={() => setCommitted(rows)}>
          Fetch balances (batched)
        </button>
        {committed && (
          <button
            style={{ ...S.button, background: "#374151" }}
            onClick={() => refresh()}
            disabled={isLoading}>
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>

      {error && (
        <pre style={{ ...S.pre, color: "#dc2626" }}>✗ {error.message}</pre>
      )}

      {balances && balances.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>address</th>
                <th style={S.th}>chain</th>
                <th style={S.th}>token</th>
                <th style={S.th}>raw</th>
                <th style={S.th}>formatted</th>
                <th style={S.th}>symbol</th>
              </tr>
            </thead>
            <tbody>
              {balances.map(({ target, balance }, i) => (
                <tr key={i}>
                  <td style={S.td}>{shortAddr(target.address)}</td>
                  <td style={S.td}>{chainLabel(target.chainId)}</td>
                  <td style={S.td}>
                    {target.tokenAddress
                      ? shortAddr(target.tokenAddress)
                      : "native"}
                  </td>
                  <td style={S.td}>{balance.raw.toString()}</td>
                  <td style={S.td}>
                    {formatUnits(balance.raw, balance.decimals ?? 0)}
                  </td>
                  <td style={S.td}>{balance.symbol ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "-apple-system, system-ui, sans-serif",
    maxWidth: 720,
    margin: "40px auto",
    padding: "0 20px",
    color: "#1b1d21",
  },
  h1: { fontSize: 22 },
  h2: { fontSize: 16, margin: "0 0 4px" },
  hint: { color: "#6b7280", lineHeight: 1.5, fontSize: 13 },
  card: {
    border: "1px solid #e6e8eb",
    borderRadius: 14,
    padding: 20,
    margin: "20px 0",
  },
  label: {
    display: "block",
    margin: "12px 0 4px",
    fontSize: 12,
    fontWeight: 600,
  },
  input: {
    width: "100%",
    padding: "9px 11px",
    border: "1px solid #ddd",
    borderRadius: 8,
    fontSize: 14,
    boxSizing: "border-box",
  },
  row: { display: "flex", gap: 10 },
  col: { flex: 1 },
  button: {
    background: "#5b5bd6",
    color: "#fff",
    border: 0,
    padding: "11px 16px",
    borderRadius: 9,
    fontSize: 14,
    cursor: "pointer",
    marginTop: 16,
  },
  buttonDisabled: { opacity: 0.5, cursor: "default" },
  targetRow: { display: "flex", gap: 8, alignItems: "center", marginTop: 8 },
  addBtn: {
    background: "none",
    color: "#5b5bd6",
    border: "1px dashed #c7c7e6",
    padding: "8px 12px",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    marginTop: 10,
  },
  removeBtn: {
    background: "none",
    color: "#9ca3af",
    border: "1px solid #e6e8eb",
    borderRadius: 8,
    width: 34,
    height: 38,
    fontSize: 18,
    lineHeight: 1,
    cursor: "pointer",
    flex: "0 0 auto",
  },
  partial: { fontSize: 13, color: "#b45309", marginTop: 12 },
  pre: {
    background: "#f5f5f7",
    padding: 12,
    borderRadius: 8,
    fontSize: 12,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    minHeight: 40,
  },
  stateRow: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
    fontSize: 12,
    color: "#374151",
    marginTop: 10,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 13,
    marginTop: 12,
  },
  th: {
    textAlign: "left",
    padding: "7px 8px",
    borderBottom: "1px solid #eee",
    color: "#6b7280",
    fontWeight: 600,
  },
  td: {
    textAlign: "left",
    padding: "7px 8px",
    borderBottom: "1px solid #eee",
    fontVariantNumeric: "tabular-nums",
    wordBreak: "break-all",
  },
};
