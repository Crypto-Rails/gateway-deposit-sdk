/**
 * Theme tokens and stylesheet for the deposit modal.
 *
 * The stylesheet is emitted with every color/measure exposed as a CSS custom
 * property on `:host` (e.g. `--dw-accent`, `--dw-bg`). That gives consumers two
 * levels of control without ejecting from the SDK:
 *
 *  1. `config.tokens` — override individual design tokens (colors, radius,
 *     font) and the whole modal re-themes consistently.
 *  2. `config.css` — a raw CSS string appended after the base sheet inside the
 *     shadow root. Redefine `--dw-*` variables, or override any `.dw-*` rule
 *     outright for full control.
 */

/** The design tokens that drive the modal's appearance. */
export interface ThemeTokens {
  /** Primary accent (active tab, spinner, copy button, links). */
  accent: string;
  /** Text color used on the accent (e.g. active tab label). */
  accentText: string;
  /** Card background. */
  bg: string;
  /** Primary text color. */
  fg: string;
  /** Secondary / muted text color. */
  sub: string;
  /** Border and hairline color. */
  border: string;
  /** Subtle fill for chips, the address pill and the close button. */
  chip: string;
  /** Full-screen scrim behind the card. */
  overlay: string;
  /** Success color (deposit received). */
  success: string;
  /** Error color (timeout / failure). */
  error: string;
  /** Toast background. */
  toastBg: string;
  /** Toast text color. */
  toastFg: string;
  /** Card corner radius. */
  radius: string;
  /** Font stack for the modal chrome. */
  fontFamily: string;
  /** Monospace font stack for the address pill. */
  monoFontFamily: string;
}

const FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, monospace";

/** Default tokens for the light and dark palettes. */
export function defaultTokens(dark: boolean): ThemeTokens {
  return {
    accent: "#5b5bd6",
    accentText: "#ffffff",
    bg: dark ? "#16181d" : "#ffffff",
    fg: dark ? "#e8eaed" : "#1b1d21",
    sub: dark ? "#9aa0aa" : "#6b7280",
    border: dark ? "#2a2d34" : "#e6e8eb",
    chip: dark ? "#22252c" : "#f3f4f6",
    overlay: dark ? "rgba(0,0,0,0.62)" : "rgba(17,20,24,0.42)",
    success: "#16a34a",
    error: "#dc2626",
    toastBg: dark ? "#0f1115" : "#111418",
    toastFg: "#ffffff",
    radius: "18px",
    fontFamily: FONT_STACK,
    monoFontFamily: MONO_STACK,
  };
}

/**
 * Merge caller token overrides onto the palette defaults. `accent` is accepted
 * both as a dedicated token and (for backward compatibility) as a top-level
 * config field, resolved by the caller before this runs.
 */
export function resolveTokens(
  dark: boolean,
  overrides?: Partial<ThemeTokens>,
): ThemeTokens {
  const base = defaultTokens(dark);
  if (!overrides) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) (out as Record<string, string>)[k] = v as string;
  }
  return out;
}

/** Emit the `:host` custom-property block from a resolved token set. */
function tokenVars(tokens: ThemeTokens): string {
  return `
  --dw-accent: ${tokens.accent};
  --dw-accent-text: ${tokens.accentText};
  --dw-bg: ${tokens.bg};
  --dw-fg: ${tokens.fg};
  --dw-sub: ${tokens.sub};
  --dw-border: ${tokens.border};
  --dw-chip: ${tokens.chip};
  --dw-overlay: ${tokens.overlay};
  --dw-success: ${tokens.success};
  --dw-error: ${tokens.error};
  --dw-toast-bg: ${tokens.toastBg};
  --dw-toast-fg: ${tokens.toastFg};
  --dw-radius: ${tokens.radius};
  --dw-font: ${tokens.fontFamily};
  --dw-mono-font: ${tokens.monoFontFamily};`;
}

/**
 * Build the modal stylesheet. Every rule references `var(--dw-*)`, so the look
 * is fully determined by the token block — and overridable via `extraCss`.
 *
 * @param tokens   Resolved design tokens.
 * @param extraCss Optional raw CSS appended verbatim after the base sheet
 *                 (`config.css`). Wins over base rules by source order.
 */
export function modalCss(tokens: ThemeTokens, extraCss?: string): string {
  return `
:host {
  all: initial;${tokenVars(tokens)}
}
* { box-sizing: border-box; font-family: var(--dw-font); }

.dw-overlay {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center;
  background: var(--dw-overlay); backdrop-filter: blur(2px);
  padding: 16px; animation: dw-fade .18s ease;
}
.dw-card {
  width: 100%; max-width: 360px; background: var(--dw-bg); color: var(--dw-fg);
  border: 1px solid var(--dw-border); border-radius: var(--dw-radius);
  box-shadow: 0 24px 60px rgba(0,0,0,.28);
  overflow: hidden; animation: dw-pop .2s cubic-bezier(.2,.8,.2,1);
}
.dw-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 16px 18px 10px;
}
.dw-head-text { min-width: 0; }
.dw-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; }
.dw-subtitle { font-size: 12px; color: var(--dw-sub); margin-top: 2px; font-weight: 500; }
.dw-x {
  border: none; background: var(--dw-chip); color: var(--dw-sub);
  width: 28px; height: 28px; border-radius: 8px; cursor: pointer;
  font-size: 15px; line-height: 1; display: grid; place-items: center;
  flex: 0 0 auto;
}
.dw-x:hover { color: var(--dw-fg); }

.dw-tabs { display: flex; gap: 6px; padding: 0 14px 8px; overflow-x: auto; }
.dw-tab {
  border: 1px solid var(--dw-border); background: transparent; color: var(--dw-sub);
  padding: 6px 10px; border-radius: 999px; font-size: 12px; cursor: pointer;
  white-space: nowrap; flex: 0 0 auto;
}
.dw-tab[data-active="true"] { background: var(--dw-accent); border-color: var(--dw-accent); color: var(--dw-accent-text); }
.dw-tab[data-funded="true"]::after { content: " ✓"; }

.dw-body { padding: 6px 18px 18px; }
.dw-qr {
  background: #fff; border-radius: 14px; padding: 12px;
  width: 208px; height: 208px; margin: 4px auto 14px;
  display: grid; place-items: center;
}
.dw-qr svg { width: 100%; height: 100%; display: block; }

.dw-meta { font-size: 12px; color: var(--dw-sub); text-align: center; margin-bottom: 8px; }
.dw-addr {
  display: flex; align-items: center; gap: 8px; justify-content: space-between;
  background: var(--dw-chip); border-radius: 10px; padding: 9px 12px;
  font-size: 12.5px; font-family: var(--dw-mono-font);
}
/* Full address, wrapped across lines — every character stays visible so users
   can verify it against the QR before sending. */
.dw-addr span { flex: 1; min-width: 0; word-break: break-all; text-align: left; line-height: 1.5; }
.dw-copy {
  border: none; background: transparent; color: var(--dw-accent);
  cursor: pointer; font-size: 12px; font-weight: 600; padding: 2px 4px;
  flex: 0 0 auto; white-space: nowrap; align-self: flex-start;
}
.dw-status {
  display: flex; align-items: center; gap: 8px; justify-content: center;
  margin-top: 14px; font-size: 13px; color: var(--dw-sub);
}
.dw-spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid var(--dw-border); border-top-color: var(--dw-accent);
  animation: dw-spin .8s linear infinite;
}
.dw-status[data-tone="success"] { color: var(--dw-success); font-weight: 600; }
.dw-status[data-tone="error"] { color: var(--dw-error); }

.dw-toast {
  position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%);
  z-index: 2147483001; background: var(--dw-toast-bg); color: var(--dw-toast-fg);
  padding: 12px 16px; border-radius: 12px; font-size: 13px; font-weight: 550;
  box-shadow: 0 12px 32px rgba(0,0,0,.35); display: flex; gap: 10px; align-items: center;
  max-width: min(92vw, 420px); animation: dw-toast-in .28s cubic-bezier(.2,.9,.2,1);
}
.dw-toast .dw-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dw-success); flex: 0 0 auto; }
.dw-toast[data-leaving="true"] { animation: dw-toast-out .25s ease forwards; }

@keyframes dw-spin { to { transform: rotate(360deg); } }
@keyframes dw-fade { from { opacity: 0; } }
@keyframes dw-pop { from { opacity: 0; transform: translateY(8px) scale(.98); } }
@keyframes dw-toast-in { from { opacity: 0; transform: translate(-50%, 12px); } }
@keyframes dw-toast-out { to { opacity: 0; transform: translate(-50%, 12px); } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
${extraCss ? `\n/* ---- config.css overrides ---- */\n${extraCss}\n` : ""}`;
}
