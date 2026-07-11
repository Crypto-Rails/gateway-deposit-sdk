// Headless DOM test: proves the modal renders and the deposit flow resolves.
// Simulates the exact user action: open() → modal appears → balance rises → toast.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;

// Balance stays at baseline until we flip `deposited`, so we can inspect the
// modal while it's still open and waiting.
let deposited = false;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    jsonrpc: "2.0",
    id: 1,
    result: deposited ? "0xde0b6b3a7640000" : "0x0", // 0 → 1e18 (1 token)
  }),
});

const { watchDeposits } = await import("../dist/index.js");

// Guard: opening with a bad-checksum address must reject before any modal shows.
let rejectedBadAddress = false;
try {
  await watchDeposits([{ address: "0xD8da6bf26964af9d7eed9e03e53415d37aa96045", chainId: 1 }]);
} catch (e) {
  rejectedBadAddress = /checksum/i.test(e.message);
}

// Guard: a valid address but bad TOKEN address must also reject.
let rejectedBadToken = false;
try {
  await watchDeposits([
    { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", tokenAddress: "0x1234", chainId: 1 },
  ]);
} catch (e) {
  rejectedBadToken = /tokenAddress/i.test(e.message);
}

let toastAtDeposit = false;
let apiCallDone = false;
let apiFinishedBeforeResolve = false;
const resultPromise = watchDeposits(
  [{ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chainId: 1 }],
  {
    // Function 1: "positive" detection (default) — any balance = deposit.
    detect: "positive",
    pollIntervalMs: 60,
    autoCloseDelayMs: 300,
    config: { title: "Test deposit" },
    // Async "API call" — must be awaited before the promise resolves.
    onDeposit: async () => {
      const s = document.querySelector("[data-deposit-watch]")?.shadowRoot;
      toastAtDeposit = !!s?.querySelector(".dw-toast");
      await new Promise((r) => setTimeout(r, 80));
      apiCallDone = true;
    },
  },
);
resultPromise.then(() => {
  apiFinishedBeforeResolve = apiCallDone; // was the async hook awaited?
});

// Wait for the async mount (createModal renders QR SVGs first), then inspect.
await new Promise((r) => setTimeout(r, 200));
const shadow = document.querySelector("[data-deposit-watch]")?.shadowRoot;

const checks = {
  "bad-checksum address rejected": rejectedBadAddress,
  "bad token address rejected": rejectedBadToken,
  "no modal left open after rejection": !document.querySelector("[data-deposit-watch]") || !!shadow,
  "modal mounted": !!shadow,
  "QR svg rendered": !!shadow?.querySelector(".dw-qr svg"),
  "title correct": shadow?.querySelector(".dw-title")?.textContent === "Test deposit",
  "waiting status shown": /Waiting/.test(shadow?.querySelector(".dw-status")?.textContent ?? ""),
  "address shown": /0xd8dA/i.test(shadow?.querySelector(".dw-addr")?.textContent ?? ""),
  "credit shown": /Supported by/.test(shadow?.querySelector(".dw-credit")?.textContent ?? ""),
  "credit links to cryptorails.tech":
    shadow?.querySelector(".dw-credit a")?.getAttribute("href") === "https://cryptorails.tech",
};

// Now simulate funds arriving.
deposited = true;
const result = await resultPromise;

checks["resolved as funded"] = result.status === "funded";
checks["delta = full balance (1)"] = result.status === "funded" && result.event.deltaFormatted === "1";
checks["toast fired on deposit"] = toastAtDeposit;
checks["async onDeposit awaited"] = apiFinishedBeforeResolve;

let pass = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "✓" : "✗"} ${k}`);
  if (!v) pass = false;
}
console.log(pass ? "\nALL CHECKS PASSED" : "\nFAILED");
process.exit(pass ? 0 : 1);
