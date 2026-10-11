// Deterministic balance tests: EVM Multicall3, Solana native chunks/token
// batches, and bounded TRON Multicall3 with batch and individual fallback.
// Covers request budgets, ABI conversion, ordering, metadata reuse, partial
// failures, and watcher baseline safety. Run: node examples/batch-test.mjs
import {
  getBalances,
  getBalance,
  watchDeposits,
  encodeAggregate3,
  decodeAggregate3,
  tronBase58ToEvmHex,
  base58Decode,
} from "../dist/index.js";

const STRESS = 500;

// ---- tiny assertion harness --------------------------------------------------
let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    failures++;
    console.log(`✗ ${msg}`);
  }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg}${actual === expected ? "" : ` (got ${actual}, want ${expected})`}`);
}

// ---- hex/ABI helpers (mirror multicall.ts, used to fake RPC *responses*) ------
function w(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}
function encBytes(noHex) {
  const len = noHex.length / 2;
  const padded = noHex.padEnd(Math.ceil(noHex.length / 64) * 64, "0");
  return w(len) + padded;
}
// One aggregate3 result element: tuple(bool success, bytes returnData).
function encTuple(dataNoHex, success = true) {
  return w(success ? 1 : 0) + w(0x40) + encBytes(dataNoHex);
}
// Encode the `(bool,bytes)[]` return value that decodeAggregate3() expects.
function encodeAggregate3Return(datas, failed = []) {
  const elems = datas.map((d, i) => encTuple(d, !failed.includes(i)));
  let offsets = "";
  let tail = "";
  let running = datas.length * 32;
  for (const e of elems) {
    offsets += w(running);
    running += e.length / 2;
    tail += e;
  }
  return "0x" + w(0x20) + w(datas.length) + offsets + tail;
}

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// ---- address generators (valid enough for each family's batch path) ----------
function evmAddress(i) {
  return "0x" + (i + 1).toString(16).padStart(40, "0");
}
function solAddress(i) {
  return `SoLTestAddr${i}`; // batch path uses the string verbatim as an RPC param
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte === 0) out += "1";
    else break;
  }
  for (let k = digits.length - 1; k >= 0; k--) out += B58[digits[k]];
  return out;
}
// 0x41-prefixed, 25-byte base58 payload. tronBase58ToEvmHex checks length+prefix
// (not the 4-byte checksum), so the trailing checksum bytes can be anything.
function tronAddress(i) {
  const payload = new Uint8Array(25);
  payload[0] = 0x41;
  new DataView(payload.buffer).setUint32(17, i + 1);
  return base58Encode(payload);
}

// A "0x…" mint stand-in for SPL isn't needed — Solana uses base58 mints, but the
// batch path passes tokenAddress straight through, so any string is fine here.
const SPL_MINT = "MintTestAddr0000000000000000000000000000000";

console.log("── unit: aggregate3 encode/decode round-trips ──");
{
  const decoded = decodeAggregate3(encodeAggregate3Return([w(11), w(22), w(33)]));
  eq(decoded.length, 3, "decodeAggregate3 returns all elements");
  eq(BigInt(decoded[0].data.slice(0, 66)), 11n, "element 0 decodes");
  eq(BigInt(decoded[2].data.slice(0, 66)), 33n, "element 2 decodes");
  // The calldata encoder must round-trip its own array length for the mock below.
  const calls = [
    { target: "0x" + "11".repeat(20), callData: "70a08231" + "0".repeat(64) },
    { target: "0x" + "22".repeat(20), callData: "313ce567" },
  ];
  const cd = encodeAggregate3(calls).slice(2);
  eq(parseInt(cd.slice(8 + 64, 8 + 128), 16), 2, "encodeAggregate3 embeds call count");
}

console.log("\n── unit: tron address generator round-trips through base58Decode ──");
{
  const a = tronAddress(0);
  const d = base58Decode(a);
  eq(d.length, 25, "generated Tron address decodes to 25 bytes");
  eq(d[0], 0x41, "generated Tron address has 0x41 prefix");
  ok(/^0x[0-9a-f]{40}$/.test(tronBase58ToEvmHex(a)), "tronBase58ToEvmHex accepts it");
}

// Every generated address ends in its index; the mock derives a per-target value
// from it so batch id / array position never has to line up with input order.
const idxOf = (addr) => Number(addr.match(/\d+$/)?.[0] ?? 0);
const splValue = (amount) => ({
  context: { slot: 1 },
  value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(amount), decimals: 6 } } } } } }],
});

// ---- a single mock that serves all three families and counts requests --------
// Solana native reads now use getMultipleAccounts (one single-object request per
// ≤100-key chunk); SPL reads stay a getTokenAccountsByOwner JSON-RPC batch. Each
// target's balance is value = (index-in-its-address + 1).
function makeMock() {
  const counts = { evm: 0, solana: 0, tron: 0 };
  const fetchFn = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (Array.isArray(payload)) {
      const method = payload[0]?.method ?? "";
      if (method.startsWith("eth_")) {
        counts.tron++;
        // eth_getBalance → hex; id is the batch index, value = id+1.
        return jsonResponse(
          payload.map((c) => ({ jsonrpc: "2.0", id: c.id, result: "0x" + BigInt(c.id + 1).toString(16) })),
        );
      }
      // Solana SPL batch: getTokenAccountsByOwner, value keyed off the owner addr.
      counts.solana++;
      return jsonResponse(
        payload.map((c) => ({ jsonrpc: "2.0", id: c.id, result: splValue(idxOf(c.params[0]) + 1) })),
      );
    }
    // Single object: Solana getMultipleAccounts, or EVM Multicall3 eth_call.
    if (payload.method === "getMultipleAccounts") {
      counts.solana++;
      const addrs = payload.params[0];
      return jsonResponse({
        jsonrpc: "2.0",
        id: payload.id,
        result: { context: { slot: 1 }, value: addrs.map((a) => ({ lamports: idxOf(a) + 1 })) },
      });
    }
    if (_url.includes("tron")) {
      counts.tron++;
      const calls = aggregateCalls(payload.params[0].data);
      return jsonResponse({ jsonrpc: "2.0", id: payload.id,
        result: encodeAggregate3Return(calls.map(c => w(BigInt("0x" + c.data.slice(-8))))) });
    }
    counts.evm++;
    const dataNoHex = payload.params[0].data.slice(2);
    const n = parseInt(dataNoHex.slice(8 + 64, 8 + 128), 16);
    const datas = Array.from({ length: n }, (_, i) => w(i + 1));
    return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: encodeAggregate3Return(datas) });
  };
  return { fetchFn, counts };
}

const rpcUrls = {
  1: "https://mock-evm",
  "solana-mainnet": "https://mock-sol",
  "tron-mainnet": "https://mock-tron",
};

console.log("\n── EVM Multicall3: 500 addresses → 1 eth_call ──");
{
  const { fetchFn, counts } = makeMock();
  const targets = Array.from({ length: STRESS }, (_, i) => ({ address: evmAddress(i), chainId: 1 }));
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  eq(counts.evm, 1, `${STRESS} EVM targets took exactly 1 HTTP request`);
  eq(out.length, STRESS, "one result per target");
  const ordered = out.every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(ordered, "all 500 balances decoded in input order");
  eq(out[STRESS - 1].balance.raw, BigInt(STRESS), "last target's balance is correct");
}

console.log("\n── Solana getMultipleAccounts: 500 native → 5 requests (100-key chunks) ──");
{
  const { fetchFn, counts } = makeMock();
  const targets = Array.from({ length: STRESS }, (_, i) => ({ address: solAddress(i), chainId: "solana-mainnet" }));
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  eq(counts.solana, 5, `${STRESS} native targets chunked into 5 getMultipleAccounts requests`);
  const ordered = out.every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(ordered, "all 500 lamport balances decoded in input order across chunk boundaries");
  eq(out[0].balance.symbol, "SOL", "native target tagged SOL");
  eq(out[STRESS - 1].balance.raw, BigInt(STRESS), "last target's balance is correct");
}

console.log("\n── Solana native + SPL mix: getMultipleAccounts chunks + one token batch ──");
{
  const { fetchFn, counts } = makeMock();
  const targets = Array.from({ length: STRESS }, (_, i) =>
    i % 2 === 0
      ? { address: solAddress(i), chainId: "solana-mainnet" }
      : { address: solAddress(i), tokenAddress: SPL_MINT, chainId: "solana-mainnet" },
  );
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  // 250 native → ceil(250/100)=3 getMultipleAccounts requests; 250 SPL → 1 batch.
  eq(counts.solana, 4, `250 native (3 chunks) + 250 SPL (1 batch) → 4 requests`);
  const ordered = out.every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(ordered, "all 500 balances (native + SPL) decoded in input order");
  eq(out[0].balance.symbol, "SOL", "native target tagged SOL");
  eq(out[1].balance.symbol, undefined, "SPL target has no native symbol");
  eq(out[1].balance.decimals, 6, "SPL decimals decoded from the token account");
}

console.log("\n── Tron Multicall3: 500 addresses → 5 chunks ──");
{
  const { fetchFn, counts } = makeMock();
  const targets = Array.from({ length: STRESS }, (_, i) => ({ address: tronAddress(i), chainId: "tron-mainnet" }));
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  eq(counts.tron, 5, `${STRESS} Tron targets took 5 bounded Multicall3 requests`);
  const ordered = out.every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(ordered, "all 500 balances decoded in input order");
  eq(out[0].balance.symbol, "TRX", "native target tagged TRX");
  eq(out[0].balance.decimals, 6, "TRX uses 6 decimals");
}

console.log("\n── mixed families in ONE getBalances call: 3×500 → 11 requests total ──");
{
  const { fetchFn, counts } = makeMock();
  const evm = Array.from({ length: STRESS }, (_, i) => ({ address: evmAddress(i), chainId: 1 }));
  const sol = Array.from({ length: STRESS }, (_, i) => ({ address: solAddress(i), chainId: "solana-mainnet" }));
  const tron = Array.from({ length: STRESS }, (_, i) => ({ address: tronAddress(i), chainId: "tron-mainnet" }));
  const targets = [...evm, ...sol, ...tron];
  const out = await getBalances(targets, { rpcUrls, fetchFn });

  // EVM 1 multicall + Solana 5 native chunks + TRON 5 multicalls = 11.
  eq(counts.evm + counts.solana + counts.tron, 11, "1500 targets across 3 chains → 11 HTTP requests");
  eq(counts.evm, 1, "  EVM: 1 multicall");
  eq(counts.solana, 5, "  Solana: 5 getMultipleAccounts chunks");
  eq(counts.tron, 5, "  Tron: 5 multicalls");
  // Each family reads value = (position-within-family + 1); blocks are contiguous.
  const evmOk = out.slice(0, STRESS).every((r, i) => r.balance.raw === BigInt(i + 1));
  const solOk = out.slice(STRESS, 2 * STRESS).every((r, i) => r.balance.raw === BigInt(i + 1));
  const tronOk = out.slice(2 * STRESS).every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(evmOk && solOk && tronOk, "results stay aligned to their original target index across families");
}

console.log("\n── fallback: a rejected getMultipleAccounts degrades to individual reads ──");
{
  // Solana provider 429s the getMultipleAccounts chunk (HTTP error) but answers
  // single getBalance calls — getBalances must fall back per target, in order.
  let batchTries = 0;
  let singleCalls = 0;
  const fetchFn = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (payload.method === "getMultipleAccounts") {
      batchTries++;
      return new Response("rate limited", { status: 429 });
    }
    singleCalls++;
    // Give each address a distinct balance so we can check ordering survives the fallback.
    const value = { AAAAA: 10, BBBBB: 20, CCCCC: 30 }[payload.params[0]] ?? 0;
    return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: { value } });
  };
  const targets = [
    { address: "AAAAA", chainId: "solana-mainnet" },
    { address: "BBBBB", chainId: "solana-mainnet" },
    { address: "CCCCC", chainId: "solana-mainnet" },
  ];
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  eq(batchTries, 1, "getMultipleAccounts attempted once");
  eq(singleCalls, targets.length, "then fell back to one getBalance per target");
  const vals = out.map((r) => r.balance.raw);
  ok(vals[0] === 10n && vals[1] === 20n && vals[2] === 30n, "fallback preserved per-target values and order");
}

console.log("\n── consistency: batched values equal individual getBalance() reads ──");
{
  // Derive every Solana balance from the address index so the batch path
  // (getMultipleAccounts / token batch) and the individual path (getBalance /
  // getTokenAccountsByOwner) agree by construction, regardless of request shape.
  const splAccount = (amount) => ({
    value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(amount), decimals: 6 } } } } } }],
  });
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    if (Array.isArray(p)) {
      // SPL token batch: getTokenAccountsByOwner, keyed off the owner address.
      return jsonResponse(
        p.map((c) => ({ jsonrpc: "2.0", id: c.id, result: splAccount(idxOf(c.params[0]) + 1) })),
      );
    }
    if (p.method === "getMultipleAccounts") {
      return jsonResponse({
        jsonrpc: "2.0",
        id: p.id,
        result: { value: p.params[0].map((a) => ({ lamports: idxOf(a) + 1 })) },
      });
    }
    if (p.method === "getBalance") {
      return jsonResponse({ jsonrpc: "2.0", id: p.id, result: { value: idxOf(p.params[0]) + 1 } });
    }
    // individual getTokenAccountsByOwner
    return jsonResponse({ jsonrpc: "2.0", id: p.id, result: splAccount(idxOf(p.params[0]) + 1) });
  };
  const targets = [
    { address: solAddress(0), chainId: "solana-mainnet" },
    { address: solAddress(1), tokenAddress: SPL_MINT, chainId: "solana-mainnet" },
  ];
  const batched = await getBalances(targets, { rpcUrls, fetchFn });
  for (let i = 0; i < targets.length; i++) {
    const single = await getBalance(targets[i], { rpcUrls, fetchFn });
    eq(single.raw, batched[i].balance.raw, `target ${i}: batch raw == individual raw`);
  }
}


function aggregateCalls(hex) {
  const h = hex.slice(10);
  const read = (pos) => Number(BigInt("0x" + h.slice(pos, pos + 64)));
  const start = read(0) * 2;
  const offsets = start + 64;
  return Array.from({ length: read(start) }, (_, i) => {
    const tuple = offsets + read(offsets + i * 64) * 2;
    const bytes = tuple + read(tuple + 128) * 2;
    return { to: "0x" + h.slice(tuple + 24, tuple + 64),
      data: h.slice(bytes + 64, bytes + 64 + read(bytes) * 2) };
  });
}

console.log("\n── TRON mixed reads, decimals deduplication and headers ──");
{
  const token = tronAddress(99);
  const owner = tronAddress(0);
  const targets = [
    { address: owner, chainId: "tron-mainnet" },
    { address: owner, tokenAddress: token, chainId: "tron-mainnet" },
    { address: tronAddress(1), tokenAddress: token, chainId: "tron-mainnet" },
  ];
  let wire;
  const fetchFn = async (url, init) => {
    const p = JSON.parse(init.body);
    wire = { url, headers: init.headers, p };
    if (Array.isArray(p)) return jsonResponse(p.map(c => ({ id: c.id, result: "0x0" })));
    return jsonResponse({ id: p.id, result: encodeAggregate3Return([w(12), w(34), w(6), w(56)]) });
  };
  const out = await getBalances(targets, { rpcUrls, fetchFn,
    rpcHeaders: { "tron-mainnet": { "x-test-key": "test" } } });
  eq(out.map(r => r.balance.raw).join(), "12,34,56", "mixed balances stay aligned around metadata call");
  eq(out[2].balance.decimals, 6, "shared token decimals applied to both targets");
  eq(wire.headers["x-test-key"], "test", "configured headers reach the aggregate");
  eq(wire.p.params?.[0]?.to, "0x32a4f47a74a6810bd0bf861cabab99656a75de9e", "uses TRON deployment, not EVM canonical address");
  if (!Array.isArray(wire.p)) {
    const calls = aggregateCalls(wire.p.params[0].data);
    eq(calls.length, 4, "one decimals read per shared token");
    eq(calls[0].data.slice(0, 8), "4d2301cc", "native TRX uses getEthBalance");
    eq(calls[1].to, tronBase58ToEvmHex(token), "TRC-20 target converted to 20-byte hex");
    eq(calls[1].data, "70a08231" + tronBase58ToEvmHex(owner).slice(2).padStart(64, "0"), "balanceOf ABI contains converted owner");
  }
}

console.log("\n── TRON fallback, shuffled batch responses and errors ──");
for (const chainId of ["tron-mainnet", "tron-shasta"]) {
  let aggregates = 0;
  const targets = [0, 1].map(i => ({ address: tronAddress(i), chainId }));
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    if (!Array.isArray(p)) {
      aggregates++;
      return jsonResponse({ id: p.id, error: { code: -32000, message: "unsupported" } });
    }
    return jsonResponse(p.map(c => ({ id: c.id, result: c.id === 0 ? "0xb" : "0x16" })).reverse());
  };
  const out = await getBalances(targets, { rpcUrls: { [chainId]: "https://mock-tron" }, fetchFn });
  eq(aggregates, chainId === "tron-mainnet" ? 1 : 0, `${chainId}: aggregate attempted only on mainnet`);
  eq(out.map(r => r.balance.raw).join(), "11,22", "batch fallback matches responses by id");
}
{
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    const error = { code: -32000, message: "read failed" };
    return jsonResponse(Array.isArray(p) ? p.map(c => ({ id: c.id, error })) : { id: p.id, error });
  };
  const [out] = await getBalances([{ address: tronAddress(0), chainId: "tron-mainnet" }], { rpcUrls, fetchFn });
  ok(out.error instanceof Error, "exhausted reads report an error instead of a successful zero");
}


console.log("\n── TRON empty balance responses stay errors ──");
{
  const target = { address: tronAddress(0), tokenAddress: tronAddress(99), decimals: 6, chainId: "tron-mainnet" };
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    return jsonResponse(Array.isArray(p) ? p.map(c => ({ id: c.id, result: "0x" })) : { id: p.id, result: "0x" });
  };
  const [out] = await getBalances([target], { rpcUrls, fetchFn });
  ok(out.error instanceof Error, "empty aggregate, batch and individual responses never become a successful zero");
}

console.log("\n── TRON partial failures preserve successful subcalls ──");
{
  let singles = 0;
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    if (Array.isArray(p)) return new Response("rate limited", { status: 429 });
    if (p.method === "eth_call") return jsonResponse({ id: p.id,
      result: encodeAggregate3Return([w(99), ""], [1]) });
    singles++;
    return jsonResponse({ id: p.id, error: { code: -32000, message: "read unavailable" } });
  };
  const out = await getBalances([0, 1].map(i => ({ address: tronAddress(i), chainId: "tron-mainnet" })), { rpcUrls, fetchFn });
  eq(out[0].balance.raw, 99n, "successful aggregate subcall survives failed retry batch");
  ok(!out[0].error && out[1].error instanceof Error, "only the unavailable target is marked failed");
  eq(singles, 1, "individual fallback retries only the failed balance");
}

console.log("\n── TRON metadata call budget and cache across chunks ──");
{
  const sizes = [];
  let metadataReads = 0;
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    const calls = aggregateCalls(p.params[0].data);
    sizes.push(calls.length);
    return jsonResponse({ id: p.id, result: encodeAggregate3Return(calls.map(c => {
      if (c.data === "313ce567") { metadataReads++; return w(6); }
      return w(BigInt("0x" + c.data.slice(-8)));
    })) });
  };
  const targets = Array.from({ length: STRESS }, (_, i) => ({
    address: tronAddress(i), tokenAddress: tronAddress(900), chainId: "tron",
  }));
  const out = await getBalances(targets, { rpcUrls: { tron: "https://mock-tron" }, fetchFn });
  eq(sizes.join(), "100,100,100,100,100,1", "metadata is included in the 100-call chunk budget");
  eq(metadataReads, 1, "token decimals fetched once across all chunks");
  ok(out.every((r, i) => r.balance.raw === BigInt(i + 1) && r.balance.decimals === 6 && !r.error),
    "tron alias uses Multicall3 and retains all balances and metadata across boundaries");
}

console.log("\n── watcher: grouped TRON reads, safe baselines and cached decimals ──");
{
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, KeyboardEvent: dom.window.KeyboardEvent });
  const owner = "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb";
  const token = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  let stage = 0;
  let aggregateReads = 0;
  const sizes = [];
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    if (stage === 0) {
      const error = { code: -32000, message: "temporary failure" };
      return jsonResponse(Array.isArray(p) ? p.map(c => ({ id: c.id, error })) : { id: p.id, error });
    }
    if (Array.isArray(p)) return jsonResponse(p.map(c => ({ id: c.id, error: { code: -32000, message: "metadata unavailable" } })));
    if (p.params?.[0]?.data?.slice(0, 10) !== "0x82ad56cb") {
      return jsonResponse({ id: p.id, error: { code: -32000, message: "expected grouped read" } });
    }
    aggregateReads++;
    const calls = aggregateCalls(p.params[0].data);
    sizes.push(calls.length);
    return jsonResponse({ id: p.id, result: encodeAggregate3Return(calls.map(c =>
      w(c.data === "313ce567" ? 6 : stage < 3 ? 9 : 12)),
      stage === 1 ? calls.flatMap((c, i) => c.data === "313ce567" ? [i] : []) : []) });
  };
  let firstPollEmpty = false;
  const tokenDecimals = [];
  const result = await watchDeposits([
    { address: owner, chainId: "tron-mainnet" },
    { address: owner, tokenAddress: token, chainId: "tron-mainnet" },
  ], { detect: "increase", pollIntervalMs: 10, timeoutMs: 1500, autoCloseDelayMs: 0,
    config: { rpcUrls, fetchFn },
    onPoll: snapshots => { if (stage === 0) firstPollEmpty = snapshots.size === 0;
      for (const [target, snap] of snapshots) if (target.tokenAddress) tokenDecimals.push(snap.decimals);
      stage++; } });
  await new Promise(resolve => setTimeout(resolve, 5));
  eq(result.status, "funded", "grouped watcher detects the eventual increase");
  eq(result.status === "funded" ? result.event.deltaRaw : undefined, 3n, "failed initial read never establishes a zero baseline");
  ok(firstPollEmpty, "failed reads omitted from poll snapshots");
  eq(aggregateReads, 3, "each successful poll groups both targets in one aggregate");
  eq(sizes.join(), "3,3,2", "failed decimals are retried then successful metadata is reused");
  ok(tokenDecimals[0] === undefined && tokenDecimals[1] === 6 && tokenDecimals[2] === 6, "metadata recovery replaces unknown decimals with confirmed value");
  dom.window.close();
}

console.log("\n── multi-URL RPC endpoints: round-robin + failover ──");
{
  // An EVM Multicall3 mock keyed by URL. `dead` is a set of URLs whose fetch
  // throws (simulating an unreachable / erroring endpoint); every hit is
  // recorded so we can assert how load spread across the list.
  function makeUrlMock(dead = new Set()) {
    const hits = [];
    const fetchFn = async (url, init) => {
      hits.push(url);
      if (dead.has(url)) throw new Error(`network down: ${url}`);
      const payload = JSON.parse(init.body);
      const dataNoHex = payload.params[0].data.slice(2);
      const n = parseInt(dataNoHex.slice(8 + 64, 8 + 128), 16);
      const datas = Array.from({ length: n }, (_, i) => w(i + 1));
      return jsonResponse({ jsonrpc: "2.0", id: payload.id, result: encodeAggregate3Return(datas) });
    };
    return { fetchFn, hits };
  }
  const A = "https://rpc-a";
  const B = "https://rpc-b";
  const target = () => [{ address: evmAddress(0), chainId: 1 }];

  // Failover: first URL is dead → the call transparently retries the second.
  {
    const { fetchFn, hits } = makeUrlMock(new Set([A]));
    const out = await getBalances(target(), { rpcUrls: { 1: [A, B] }, fetchFn });
    eq(out[0].balance.raw, 1n, "failover: balance resolved via the surviving URL");
    ok(hits.includes(A) && hits.includes(B), "failover: both URLs were attempted");
  }

  // Round-robin: many single-target calls over a 2-URL endpoint hit BOTH URLs
  // (the starting point rotates), so load is spread rather than pinned to one.
  {
    const { fetchFn, hits } = makeUrlMock();
    for (let i = 0; i < 6; i++) await getBalances(target(), { rpcUrls: { 1: [A, B] }, fetchFn });
    ok(hits.includes(A) && hits.includes(B), "round-robin: successful calls spread across both URLs");
  }

  // All endpoints dead → failover exhausts every URL before giving up. The
  // low-level client throws; getBalances then degrades that target to a zero
  // snapshot rather than propagating (its documented per-target contract).
  {
    const { fetchFn, hits } = makeUrlMock(new Set([A, B]));
    const out = await getBalances(target(), { rpcUrls: { 1: [A, B] }, fetchFn });
    ok(hits.includes(A) && hits.includes(B), "all URLs dead → every URL was attempted before giving up");
    eq(out[0].balance.raw, 0n, "all URLs dead → target degrades to a zero balance");
  }

  // A plain string endpoint still works (single-URL, no array).
  {
    const { fetchFn, hits } = makeUrlMock();
    const out = await getBalances(target(), { rpcUrls: { 1: A }, fetchFn });
    eq(out[0].balance.raw, 1n, "string endpoint: balance resolved");
    ok(hits.every((u) => u === A), "string endpoint: only the one URL was used");
  }
}

console.log("");
if (failures === 0) {
  console.log("ALL CHECKS PASSED");
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
