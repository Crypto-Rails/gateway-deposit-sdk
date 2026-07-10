// Headless DOM test for minDepositRaw: a payment arriving in two installments
// must NOT complete until the running total reaches the threshold.
//   stage 0 → 0           (below detection floor → waiting)
//   stage 1 → 3 tokens    (< minDeposit 5 → partial, keep polling, no resolve)
//   stage 2 → 6 tokens    (>= minDeposit 5 → onDeposit fires, resolves funded)
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;

const T = 10n ** 18n; // 1 token (18 decimals)
let stage = 0;
const balanceForStage = () => (stage === 0 ? 0n : stage === 1 ? 3n * T : 6n * T);
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + balanceForStage().toString(16) }),
});

const { watchDeposits } = await import("../dist/index.js");

let onDepositFired = false;
let onDepositDelta = null;
const partialDeltas = [];

const resultPromise = watchDeposits([{ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chainId: 1 }], {
  detect: "positive",
  minDepositRaw: 5n * T, // require 5 tokens total before completing
  pollIntervalMs: 40,
  autoCloseDelayMs: 100,
  config: { title: "Min deposit test" },
  onPartialDeposit: (e) => partialDeltas.push(e.deltaFormatted),
  onDeposit: (e) => {
    onDepositFired = true;
    onDepositDelta = e.deltaFormatted;
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusText = () =>
  document.querySelector("[data-deposit-watch]")?.shadowRoot?.querySelector(".dw-status")?.textContent ?? "";

await sleep(200); // mount + first ticks at balance 0

const checks = {};
checks["waiting before any deposit"] = /Waiting/.test(statusText());
checks["onDeposit not fired at 0"] = !onDepositFired;

// First installment: 3 tokens — below the 5-token threshold.
stage = 1;
await sleep(160); // let a few polls run

checks["partial reported below threshold"] = partialDeltas.includes("3");
checks["modal shows partial progress"] = /Received 3 of 5/.test(statusText());
checks["onDeposit NOT fired on partial"] = !onDepositFired;
checks["not resolved while short"] = !onDepositDelta;

// Second installment pushes the total to 6 tokens — over the threshold.
stage = 2;
const result = await resultPromise;

checks["resolved as funded once enough"] = result.status === "funded";
checks["onDeposit fired with full total (6)"] = onDepositFired && onDepositDelta === "6";
checks["final event delta = 6"] = result.status === "funded" && result.event.deltaFormatted === "6";

let pass = true;
for (const [k, v] of Object.entries(checks)) {
  console.log(`${v ? "✓" : "✗"} ${k}`);
  if (!v) pass = false;
}
console.log(pass ? "\nALL CHECKS PASSED" : "\nFAILED");
process.exit(pass ? 0 : 1);
