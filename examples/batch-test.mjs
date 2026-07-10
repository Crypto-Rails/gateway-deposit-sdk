// Batch / multicall test: proves every "many targets → few round-trips" path
// collapses N reads into a SINGLE HTTP request, preserves input order, and
// decodes each family correctly — including a 500-address-in-one-call stress
// test for EVM (Multicall3), Solana (JSON-RPC batch) and Tron (JSON-RPC batch),
// plus the individual-read fallback when a provider rejects a batch.
//
// Run: node examples/batch-test.mjs
import {
  getBalances,
  getBalance,
  encodeAggregate3,
  decodeAggregate3,
  tronBase58ToEvmHex,
  base58Decode,
} from "../dist/index.js";

const STRESS = 500; // "500 addresses in 1 call"

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
function encTuple(dataNoHex) {
  return w(1) + w(0x40) + encBytes(dataNoHex);
}
// Encode the `(bool,bytes)[]` return value that decodeAggregate3() expects.
function encodeAggregate3Return(datas) {
  const elems = datas.map((d) => encTuple(d));
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
  for (let b = 0; b < 20; b++) payload[1 + b] = (i * 31 + b * 7 + 1) & 0xff;
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

// ---- a single mock that serves all three families and counts requests --------
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
      counts.solana++;
      return jsonResponse(
        payload.map((c) =>
          c.method === "getBalance"
            ? { jsonrpc: "2.0", id: c.id, result: { context: { slot: 1 }, value: c.id + 1 } }
            : {
                jsonrpc: "2.0",
                id: c.id,
                result: {
                  context: { slot: 1 },
                  value: [
                    {
                      account: {
                        data: { parsed: { info: { tokenAmount: { amount: String(c.id + 1), decimals: 6 } } } },
                      },
                    },
                  ],
                },
              },
        ),
      );
    }
    // Single object → EVM Multicall3 eth_call. Return one word per sub-call.
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

console.log("\n── Solana JSON-RPC batch: 500 addresses → 1 request (native + SPL mix) ──");
{
  const { fetchFn, counts } = makeMock();
  const targets = Array.from({ length: STRESS }, (_, i) =>
    i % 2 === 0
      ? { address: solAddress(i), chainId: "solana-mainnet" }
      : { address: solAddress(i), tokenAddress: SPL_MINT, chainId: "solana-mainnet" },
  );
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  eq(counts.solana, 1, `${STRESS} Solana targets took exactly 1 HTTP request`);
  const ordered = out.every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(ordered, "all 500 balances (native + SPL) decoded in input order");
  eq(out[0].balance.symbol, "SOL", "native target tagged SOL");
  eq(out[1].balance.symbol, undefined, "SPL target has no native symbol");
  eq(out[1].balance.decimals, 6, "SPL decimals decoded from the token account");
}

console.log("\n── Tron JSON-RPC batch: 500 addresses → 1 request ──");
{
  const { fetchFn, counts } = makeMock();
  const targets = Array.from({ length: STRESS }, (_, i) => ({ address: tronAddress(i), chainId: "tron-mainnet" }));
  const out = await getBalances(targets, { rpcUrls, fetchFn });
  eq(counts.tron, 1, `${STRESS} Tron targets took exactly 1 HTTP request`);
  const ordered = out.every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(ordered, "all 500 balances decoded in input order");
  eq(out[0].balance.symbol, "TRX", "native target tagged TRX");
  eq(out[0].balance.decimals, 6, "TRX uses 6 decimals");
}

console.log("\n── mixed families in ONE getBalances call: 3×500 → 3 requests total ──");
{
  const { fetchFn, counts } = makeMock();
  const evm = Array.from({ length: STRESS }, (_, i) => ({ address: evmAddress(i), chainId: 1 }));
  const sol = Array.from({ length: STRESS }, (_, i) => ({ address: solAddress(i), chainId: "solana-mainnet" }));
  const tron = Array.from({ length: STRESS }, (_, i) => ({ address: tronAddress(i), chainId: "tron-mainnet" }));
  const targets = [...evm, ...sol, ...tron];
  const out = await getBalances(targets, { rpcUrls, fetchFn });

  eq(counts.evm + counts.solana + counts.tron, 3, "1500 targets across 3 chains → 3 HTTP requests");
  eq(counts.evm, 1, "  EVM: 1 multicall");
  eq(counts.solana, 1, "  Solana: 1 batch");
  eq(counts.tron, 1, "  Tron: 1 batch");
  // Each family reads value = (position-within-family + 1); blocks are contiguous.
  const evmOk = out.slice(0, STRESS).every((r, i) => r.balance.raw === BigInt(i + 1));
  const solOk = out.slice(STRESS, 2 * STRESS).every((r, i) => r.balance.raw === BigInt(i + 1));
  const tronOk = out.slice(2 * STRESS).every((r, i) => r.balance.raw === BigInt(i + 1));
  ok(evmOk && solOk && tronOk, "results stay aligned to their original target index across families");
}

console.log("\n── fallback: a rejected batch degrades to individual reads ──");
{
  // Solana provider 429s the batch (HTTP error) but answers single calls.
  let batchTries = 0;
  let singleCalls = 0;
  const fetchFn = async (_url, init) => {
    const payload = JSON.parse(init.body);
    if (Array.isArray(payload)) {
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
  eq(batchTries, 1, "batch attempted once");
  eq(singleCalls, targets.length, "then fell back to one call per target");
  const vals = out.map((r) => r.balance.raw);
  ok(vals[0] === 10n && vals[1] === 20n && vals[2] === 30n, "fallback preserved per-target values and order");
}

console.log("\n── maxBatchSize: 500 targets split into parallel chunked requests ──");
{
  const CH = 100;
  const families = [
    { name: "EVM", count: "evm", make: (i) => ({ address: evmAddress(i), chainId: 1 }) },
    { name: "Solana", count: "solana", make: (i) => ({ address: solAddress(i), chainId: "solana-mainnet" }) },
    { name: "Tron", count: "tron", make: (i) => ({ address: tronAddress(i), chainId: "tron-mainnet" }) },
  ];
  for (const fam of families) {
    const { fetchFn, counts } = makeMock();
    const targets = Array.from({ length: STRESS }, (_, i) => fam.make(i));
    const out = await getBalances(targets, { rpcUrls, fetchFn, maxBatchSize: CH });
    eq(counts[fam.count], STRESS / CH, `${fam.name}: 500 targets @ maxBatchSize ${CH} → ${STRESS / CH} requests`);
    // Each chunk restarts value numbering at 1, so index i must read (i % CH) + 1 —
    // which only holds if every chunk's results landed at the right global indices.
    ok(
      out.every((r, i) => r.balance.raw === BigInt((i % CH) + 1)),
      `${fam.name}: all 500 values correct + in order across chunks`,
    );
  }
}

console.log("\n── maxBatchSize edge cases ──");
{
  const solTargets = () => Array.from({ length: STRESS }, (_, i) => ({ address: solAddress(i), chainId: "solana-mainnet" }));

  // Chunk size that doesn't divide evenly → last chunk is the remainder.
  {
    const { fetchFn, counts } = makeMock();
    const out = await getBalances(solTargets(), { rpcUrls, fetchFn, maxBatchSize: 200 });
    eq(counts.solana, 3, "500 @ maxBatchSize 200 → 3 requests (200 + 200 + 100)");
    ok(out.every((r, i) => r.balance.raw === BigInt((i % 200) + 1)), "remainder chunk reassembled in order");
  }

  // Limit ≥ group size → a single request (no unnecessary splitting).
  {
    const { fetchFn, counts } = makeMock();
    await getBalances(solTargets(), { rpcUrls, fetchFn, maxBatchSize: 1000 });
    eq(counts.solana, 1, "maxBatchSize ≥ group size → still 1 request");
  }

  // maxBatchSize 1 → one request per target (extreme but valid).
  {
    const { fetchFn, counts } = makeMock();
    await getBalances(solTargets(), { rpcUrls, fetchFn, maxBatchSize: 1 });
    eq(counts.solana, STRESS, "maxBatchSize 1 → one request per target");
  }

  // Invalid / non-finite values are treated as "no limit".
  for (const bad of [0, -5, NaN, Infinity]) {
    const { fetchFn, counts } = makeMock();
    await getBalances(solTargets(), { rpcUrls, fetchFn, maxBatchSize: bad });
    eq(counts.solana, 1, `maxBatchSize ${bad} treated as no limit → 1 request`);
  }
}

console.log("\n── consistency: batched values equal individual getBalance() reads ──");
{
  // Derive each Solana balance from the address index, so the batch path (keyed
  // by batch id) and the individual path (keyed by address) agree by construction.
  const idxOf = (addr) => Number(addr.match(/\d+$/)[0]);
  const splAccount = (amount) => ({
    value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(amount), decimals: 6 } } } } } }],
  });
  const fetchFn = async (_url, init) => {
    const p = JSON.parse(init.body);
    if (Array.isArray(p)) {
      return jsonResponse(
        p.map((c) =>
          c.method === "getBalance"
            ? { jsonrpc: "2.0", id: c.id, result: { value: c.id + 1 } }
            : { jsonrpc: "2.0", id: c.id, result: splAccount(c.id + 1) },
        ),
      );
    }
    const i = idxOf(p.params[0]);
    return jsonResponse(
      p.method === "getBalance"
        ? { jsonrpc: "2.0", id: p.id, result: { value: i + 1 } }
        : { jsonrpc: "2.0", id: p.id, result: splAccount(i + 1) },
    );
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

console.log("");
if (failures === 0) {
  console.log("ALL CHECKS PASSED");
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}
