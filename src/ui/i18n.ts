/**
 * Internationalization for the deposit modal.
 *
 * Every user-facing string the modal renders lives here. Consumers pick a
 * built-in locale with `config.locale` (e.g. `"es"`, `"zh"`) and/or override
 * individual strings with `config.messages`. Parameterized strings use simple
 * `{name}` placeholders so overrides stay plain, translatable, and serializable.
 */

/** The full set of strings the modal renders. All fields are required per locale. */
export interface Messages {
  /** Modal header. `config.title` (typically your company/brand name) takes precedence. */
  title: string;
  /**
   * Small line under the header — the localized "Fund your account" call to
   * action shown beneath your company name. Override with `config.subtitle`, or
   * set that to `""`/`null` to hide it.
   */
  subtitle: string;
  /** `aria-label` for the close (✕) button. */
  close: string;
  /** Copy-address button, idle state. */
  copy: string;
  /** Copy-address button, right after a successful copy. */
  copied: string;
  /** Copy-address button when the clipboard write fails. */
  copyFailed: string;
  /** Shown in the meta line when the target watches the chain's native coin. */
  nativeCoin: string;
  /** Meta line for an ERC-20 / SPL / TRC-20 token. Placeholder: `{address}`. */
  token: string;
  /** Separator between the chain name and the token label in the meta line. */
  metaSeparator: string;
  /** Status line before any deposit is seen. */
  waiting: string;
  /** Status line once the (complete) deposit lands. */
  received: string;
  /** Status line when the watch times out. */
  timedOut: string;
  /**
   * Status line while installments are still below `minDepositRaw`.
   * Placeholders: `{received}`, `{required}`, `{symbol}` (already space-prefixed
   * when present, empty otherwise).
   */
  partial: string;
  /**
   * Toast shown when a deposit completes. Placeholders: `{amount}`, `{symbol}`
   * (space-prefixed when present), `{address}` (shortened).
   */
  toastReceived: string;
}

/** English (default, fallback locale). */
const en: Messages = {
  title: "Deposit",
  subtitle: "Fund your account",
  close: "Close",
  copy: "Copy",
  copied: "Copied!",
  copyFailed: "Copy failed",
  nativeCoin: "native coin",
  token: "token {address}",
  metaSeparator: " · ",
  waiting: "Waiting for deposit…",
  received: "Deposit received ✓",
  timedOut: "Timed out waiting for a deposit.",
  partial: "Received {received} of {required}{symbol} — waiting for the rest…",
  toastReceived: "Received {amount}{symbol} at {address} ✅",
};

const es: Messages = {
  title: "Depósito",
  subtitle: "Añade fondos a tu cuenta",
  close: "Cerrar",
  copy: "Copiar",
  copied: "¡Copiado!",
  copyFailed: "Error al copiar",
  nativeCoin: "moneda nativa",
  token: "token {address}",
  metaSeparator: " · ",
  waiting: "Esperando el depósito…",
  received: "Depósito recibido ✓",
  timedOut: "Se agotó el tiempo de espera del depósito.",
  partial: "Recibido {received} de {required}{symbol} — esperando el resto…",
  toastReceived: "Recibido {amount}{symbol} en {address} ✅",
};

const fr: Messages = {
  title: "Dépôt",
  subtitle: "Alimentez votre compte",
  close: "Fermer",
  copy: "Copier",
  copied: "Copié !",
  copyFailed: "Échec de la copie",
  nativeCoin: "monnaie native",
  token: "jeton {address}",
  metaSeparator: " · ",
  waiting: "En attente du dépôt…",
  received: "Dépôt reçu ✓",
  timedOut: "Délai d’attente du dépôt dépassé.",
  partial: "Reçu {received} sur {required}{symbol} — en attente du reste…",
  toastReceived: "Reçu {amount}{symbol} à {address} ✅",
};

const de: Messages = {
  title: "Einzahlung",
  subtitle: "Laden Sie Ihr Konto auf",
  close: "Schließen",
  copy: "Kopieren",
  copied: "Kopiert!",
  copyFailed: "Kopieren fehlgeschlagen",
  nativeCoin: "native Münze",
  token: "Token {address}",
  metaSeparator: " · ",
  waiting: "Warte auf Einzahlung…",
  received: "Einzahlung erhalten ✓",
  timedOut: "Zeitüberschreitung beim Warten auf eine Einzahlung.",
  partial: "{received} von {required}{symbol} erhalten — warte auf den Rest…",
  toastReceived: "{amount}{symbol} erhalten an {address} ✅",
};

const pt: Messages = {
  title: "Depósito",
  subtitle: "Adicione fundos à sua conta",
  close: "Fechar",
  copy: "Copiar",
  copied: "Copiado!",
  copyFailed: "Falha ao copiar",
  nativeCoin: "moeda nativa",
  token: "token {address}",
  metaSeparator: " · ",
  waiting: "Aguardando o depósito…",
  received: "Depósito recebido ✓",
  timedOut: "Tempo esgotado aguardando um depósito.",
  partial: "Recebido {received} de {required}{symbol} — aguardando o restante…",
  toastReceived: "Recebido {amount}{symbol} em {address} ✅",
};

const zh: Messages = {
  title: "充值",
  subtitle: "为您的账户充值",
  close: "关闭",
  copy: "复制",
  copied: "已复制！",
  copyFailed: "复制失败",
  nativeCoin: "原生代币",
  token: "代币 {address}",
  metaSeparator: " · ",
  waiting: "等待充值…",
  received: "已收到充值 ✓",
  timedOut: "等待充值超时。",
  partial: "已收到 {received}／{required}{symbol} — 等待剩余部分…",
  toastReceived: "已在 {address} 收到 {amount}{symbol} ✅",
};

const ja: Messages = {
  title: "入金",
  subtitle: "アカウントに入金する",
  close: "閉じる",
  copy: "コピー",
  copied: "コピーしました！",
  copyFailed: "コピーに失敗しました",
  nativeCoin: "ネイティブコイン",
  token: "トークン {address}",
  metaSeparator: " · ",
  waiting: "入金を待っています…",
  received: "入金を受け取りました ✓",
  timedOut: "入金の待機がタイムアウトしました。",
  partial: "{required}{symbol} のうち {received} を受け取りました — 残りを待っています…",
  toastReceived: "{address} で {amount}{symbol} を受け取りました ✅",
};

const ru: Messages = {
  title: "Депозит",
  subtitle: "Пополните ваш счёт",
  close: "Закрыть",
  copy: "Копировать",
  copied: "Скопировано!",
  copyFailed: "Не удалось скопировать",
  nativeCoin: "нативная монета",
  token: "токен {address}",
  metaSeparator: " · ",
  waiting: "Ожидание депозита…",
  received: "Депозит получен ✓",
  timedOut: "Истекло время ожидания депозита.",
  partial: "Получено {received} из {required}{symbol} — ожидание остатка…",
  toastReceived: "Получено {amount}{symbol} на {address} ✅",
};

/**
 * Built-in locales, keyed by lowercase language code. Region subtags are
 * matched by their base language (`"zh-CN"` → `"zh"`, `"pt-BR"` → `"pt"`).
 */
export const LOCALES: Record<string, Messages> = {
  en,
  es,
  fr,
  de,
  pt,
  zh,
  ja,
  ru,
};

/** The locale used when none is specified or the requested one is unknown. */
export const DEFAULT_LOCALE = "en";

/**
 * Resolve the final message set: start from the requested built-in locale (or
 * English), then layer any per-string overrides on top. Unknown locales fall
 * back to English rather than throwing, so a typo degrades gracefully.
 */
export function resolveMessages(
  locale?: string,
  overrides?: Partial<Messages>,
): Messages {
  const base = pickLocale(locale);
  return overrides ? { ...base, ...stripUndefined(overrides) } : base;
}

function pickLocale(locale?: string): Messages {
  if (!locale) return en;
  const key = locale.toLowerCase();
  return LOCALES[key] ?? LOCALES[key.split("-")[0]!] ?? en;
}

function stripUndefined(obj: Partial<Messages>): Partial<Messages> {
  const out: Partial<Messages> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, string>)[k] = v as string;
  }
  return out;
}

/**
 * Interpolate `{name}` placeholders in a template. Missing keys are left as the
 * literal `{name}` so an incomplete override is visible rather than silently
 * blank.
 */
export function t(template: string, params: Record<string, string> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? params[key]! : match,
  );
}
