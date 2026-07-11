import { shortenAddress } from "../format.js";
import { qrSvg } from "../qr.js";
import type { DepositTarget, DepositWatchConfig } from "../types.js";
import { resolveMessages, t, type Messages } from "./i18n.js";
import { modalCss, resolveTokens } from "./styles.js";

type StatusTone = "waiting" | "success" | "error";

export interface DepositModalHandle {
  readonly element: HTMLElement;
  /** The resolved, localized strings this modal renders (for the watcher's status/toast text). */
  readonly messages: Messages;
  getActiveIndex(): number;
  setStatus(text: string, tone?: StatusTone): void;
  markFunded(index: number): void;
  toast(message: string): void;
  destroy(): void;
}

function resolveDark(theme: DepositWatchConfig["theme"]): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function chainLabel(chainId: DepositTarget["chainId"]): string {
  const names: Record<string, string> = {
    // EVM mainnets
    "1": "Ethereum",
    "10": "Optimism",
    "56": "BNB Chain",
    "137": "Polygon",
    "8453": "Base",
    "42161": "Arbitrum",
    "43114": "Avalanche",
    // EVM testnets
    "11155111": "Ethereum Sepolia",
    "17000": "Ethereum Holesky",
    "560048": "Ethereum Hoodi",
    "11155420": "Optimism Sepolia",
    "97": "BNB Testnet",
    "80002": "Polygon Amoy",
    "84532": "Base Sepolia",
    "421614": "Arbitrum Sepolia",
    "43113": "Avalanche Fuji",
    // Solana
    "solana": "Solana",
    "solana-mainnet": "Solana",
    "solana-devnet": "Solana Devnet",
    "solana-testnet": "Solana Testnet",
    // Tron
    "tron": "Tron",
    "tron-mainnet": "Tron",
    "tron-shasta": "Tron Shasta",
    "tron-nile": "Tron Nile",
  };
  const key = typeof chainId === "string" ? chainId.toLowerCase() : String(chainId);
  return names[key] ?? `Chain ${String(chainId)}`;
}

export async function createModal(
  targets: DepositTarget[],
  config: DepositWatchConfig,
  handlers: { onClose: () => void; onTabChange?: (index: number) => void },
): Promise<DepositModalHandle> {
  const dark = resolveDark(config.theme);
  const messages = resolveMessages(config.locale, config.messages);
  // `config.accent` is a back-compat shortcut for `tokens.accent`; an explicit
  // token override still wins.
  const tokens = resolveTokens(dark, {
    ...(config.accent ? { accent: config.accent } : {}),
    ...config.tokens,
  });
  const title = config.title ?? messages.title;
  // Subtitle defaults to the localized "Fund your account"; `config.subtitle`
  // overrides it, and `""`/`null` hides the line.
  const subtitle = config.subtitle !== undefined ? config.subtitle : messages.subtitle;

  const host = document.createElement("div");
  host.setAttribute("data-deposit-watch", "");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = modalCss(tokens, config.css);
  shadow.appendChild(style);

  // Pre-render QR codes for every target (crisp SVG).
  const qrCodes = await Promise.all(
    targets.map((t) => qrSvg(t.address).catch(() => "<div>QR error</div>")),
  );

  let activeIndex = 0;
  const funded = new Set<number>();

  const overlay = document.createElement("div");
  overlay.className = "dw-overlay";
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) handlers.onClose();
  });

  const card = document.createElement("div");
  card.className = "dw-card";
  overlay.appendChild(card);

  // ---- header ----
  const head = document.createElement("div");
  head.className = "dw-head";
  // Title (company name) + optional localized subtitle, stacked so the close
  // button stays pinned to the top-right.
  const headText = document.createElement("div");
  headText.className = "dw-head-text";
  const titleEl = document.createElement("div");
  titleEl.className = "dw-title";
  titleEl.textContent = title;
  headText.appendChild(titleEl);
  if (subtitle) {
    const subEl = document.createElement("div");
    subEl.className = "dw-subtitle";
    subEl.textContent = subtitle;
    headText.appendChild(subEl);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "dw-x";
  closeBtn.setAttribute("aria-label", messages.close);
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", () => handlers.onClose());
  head.append(headText, closeBtn);
  card.appendChild(head);

  // ---- tabs (only when >1 target) ----
  const tabEls: HTMLButtonElement[] = [];
  if (targets.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "dw-tabs";
    targets.forEach((t, i) => {
      const tab = document.createElement("button");
      tab.className = "dw-tab";
      tab.textContent = t.label ?? chainLabel(t.chainId);
      tab.dataset.active = String(i === 0);
      tab.addEventListener("click", () => setActive(i));
      tabs.appendChild(tab);
      tabEls.push(tab);
    });
    card.appendChild(tabs);
  }

  // ---- body ----
  const body = document.createElement("div");
  body.className = "dw-body";

  const qrBox = document.createElement("div");
  qrBox.className = "dw-qr";

  const meta = document.createElement("div");
  meta.className = "dw-meta";

  const addrRow = document.createElement("div");
  addrRow.className = "dw-addr";
  const addrText = document.createElement("span");
  const copyBtn = document.createElement("button");
  copyBtn.className = "dw-copy";
  copyBtn.textContent = messages.copy;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(targets[activeIndex]!.address);
      copyBtn.textContent = messages.copied;
      setTimeout(() => (copyBtn.textContent = messages.copy), 1400);
    } catch {
      copyBtn.textContent = messages.copyFailed;
    }
  });
  addrRow.append(addrText, copyBtn);

  const status = document.createElement("div");
  status.className = "dw-status";

  body.append(qrBox, meta, addrRow, status);
  card.appendChild(body);

  // ---- footer credit ----
  const credit = document.createElement("div");
  credit.className = "dw-credit";
  const creditLink = document.createElement("a");
  creditLink.href = "https://cryptorails.tech";
  creditLink.target = "_blank";
  creditLink.rel = "noopener noreferrer";
  creditLink.textContent = "cryptorails.tech";
  credit.append(document.createTextNode("Supported by "), creditLink);
  card.appendChild(credit);

  shadow.appendChild(overlay);
  document.body.appendChild(host);

  // Esc to close.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") handlers.onClose();
  };
  window.addEventListener("keydown", onKey);

  function renderActive(): void {
    const target = targets[activeIndex]!;
    qrBox.innerHTML = qrCodes[activeIndex]!;
    const tokenLabel = target.tokenAddress
      ? t(messages.token, { address: shortenAddress(target.tokenAddress) })
      : messages.nativeCoin;
    meta.textContent = `${chainLabel(target.chainId)}${messages.metaSeparator}${tokenLabel}`;
    // Show the FULL receiving address — never truncate it. Users must be able to
    // verify every character against the QR before sending funds.
    addrText.textContent = target.address;
    if (funded.has(activeIndex)) {
      setStatus(messages.received, "success");
    } else {
      setStatus(messages.waiting, "waiting");
    }
  }

  function setActive(i: number): void {
    activeIndex = i;
    tabEls.forEach((tab, idx) => (tab.dataset.active = String(idx === i)));
    renderActive();
    handlers.onTabChange?.(i);
  }

  function setStatus(text: string, tone: StatusTone = "waiting"): void {
    status.dataset.tone = tone;
    status.innerHTML = "";
    if (tone === "waiting") {
      const sp = document.createElement("span");
      sp.className = "dw-spinner";
      status.appendChild(sp);
    }
    const label = document.createElement("span");
    label.textContent = text;
    status.appendChild(label);
  }

  function markFunded(index: number): void {
    funded.add(index);
    if (tabEls[index]) tabEls[index]!.dataset.funded = "true";
    if (index === activeIndex) setStatus(messages.received, "success");
  }

  function toast(message: string): void {
    const el = document.createElement("div");
    el.className = "dw-toast";
    const dot = document.createElement("span");
    dot.className = "dw-dot";
    const txt = document.createElement("span");
    txt.textContent = message;
    el.append(dot, txt);
    shadow.appendChild(el);
    setTimeout(() => {
      el.dataset.leaving = "true";
      setTimeout(() => el.remove(), 260);
    }, 4200);
  }

  function destroy(): void {
    window.removeEventListener("keydown", onKey);
    host.remove();
  }

  renderActive();

  return {
    element: host,
    messages,
    getActiveIndex: () => activeIndex,
    setStatus,
    markFunded,
    toast,
    destroy,
  };
}
