// Probe the real caps for reading many Solana accounts in one shot, against the
// public nodes the SDK ships with. Answers two questions:
//
//   1. Max pubkeys in ONE getMultipleAccounts call   (protocol says 100)
//   2. Max getMultipleAccounts CALLS in one JSON-RPC batch (provider-specific)
//
// Together they bound how many native-SOL targets one getBalances() HTTP request
// can carry: (batch-call cap) × 100. Run on demand:
//   node examples/solana-cap-probe.mjs
const URLS = [
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
];

// ---- deterministic valid 32-byte base58 pubkeys (unfunded → null on read) ----
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
const pubkey = (i) => {
  const b = new Uint8Array(32);
  for (let k = 0; k < 32; k++) b[k] = (i * 131 + k * 7 + 1) & 0xff;
  return base58Encode(b);
};
const keys = (n, off = 0) => Array.from({ length: n }, (_, i) => pubkey(off + i));

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

// A single getMultipleAccounts with `n` pubkeys — did the node accept it?
async function tryGMA(url, n) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getMultipleAccounts",
    params: [keys(n), { encoding: "base64" }],
  };
  const r = await post(url, body);
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}`, sample: r.text.slice(0, 120) };
  if (r.json?.error) return { ok: false, why: `err ${r.json.error.code}`, sample: r.json.error.message };
  const got = r.json?.result?.value?.length;
  if (got !== n) return { ok: false, why: `got ${got} of ${n}`, sample: "" };
  return { ok: true };
}

// A JSON-RPC batch of `n` single-account getBalance calls (the CURRENT approach).
async function tryGetBalanceBatch(url, n) {
  const ks = keys(n);
  const body = ks.map((k, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "getBalance",
    params: [k],
  }));
  const r = await post(url, body);
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}`, sample: r.text.slice(0, 120) };
  if (!Array.isArray(r.json)) {
    const msg = r.json?.error?.message ?? "not an array";
    return { ok: false, why: "not batched", sample: msg };
  }
  if (r.json.length !== n) return { ok: false, why: `got ${r.json.length} of ${n}`, sample: "" };
  const anyErr = r.json.find((x) => x.error);
  if (anyErr) return { ok: false, why: `sub-err ${anyErr.error.code}`, sample: anyErr.error.message };
  return { ok: true };
}

// A JSON-RPC batch of `calls` getMultipleAccounts, each with `per` pubkeys.
async function tryBatch(url, calls, per) {
  const body = Array.from({ length: calls }, (_, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "getMultipleAccounts",
    params: [keys(per, i * per), { encoding: "base64" }],
  }));
  const r = await post(url, body);
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}`, sample: r.text.slice(0, 120) };
  if (!Array.isArray(r.json)) {
    const msg = r.json?.error?.message ?? "not an array";
    return { ok: false, why: "not batched", sample: msg };
  }
  if (r.json.length !== calls) return { ok: false, why: `got ${r.json.length} of ${calls}`, sample: "" };
  const anyErr = r.json.find((x) => x.error);
  if (anyErr) return { ok: false, why: `sub-err ${anyErr.error.code}`, sample: anyErr.error.message };
  return { ok: true };
}

for (const url of URLS) {
  console.log(`\n══ ${url} ══`);

  // 1) getMultipleAccounts pubkey cap — walk common thresholds.
  console.log("  getMultipleAccounts pubkey cap:");
  let gmaCap = 0;
  for (const n of [1, 50, 100, 101, 200, 256]) {
    let r;
    try {
      r = await tryGMA(url, n);
    } catch (e) {
      r = { ok: false, why: "throw", sample: e.message };
    }
    console.log(`    ${String(n).padStart(4)} → ${r.ok ? "OK" : `REJECT (${r.why}) ${r.sample}`}`);
    if (r.ok) gmaCap = n;
  }
  console.log(`    ⇒ accepted up to ${gmaCap} pubkeys in one call`);

  // 2) batch-of-gMA cap — how many 100-key getMultipleAccounts fit in one batch.
  const per = Math.min(gmaCap || 100, 100);
  console.log(`  batch of getMultipleAccounts (${per} keys each):`);
  let batchCap = 0;
  for (const calls of [1, 2, 5, 10, 20, 50]) {
    let r;
    try {
      r = await tryBatch(url, calls, per);
    } catch (e) {
      r = { ok: false, why: "throw", sample: e.message };
    }
    const addrs = calls * per;
    console.log(
      `    ${String(calls).padStart(3)} calls (${String(addrs).padStart(5)} addrs) → ${
        r.ok ? "OK" : `REJECT (${r.why}) ${r.sample}`
      }`,
    );
    if (r.ok) batchCap = calls;
  }
  console.log(
    `    ⇒ up to ${batchCap} calls / batch ≈ ${batchCap * per} native addrs in ONE HTTP request`,
  );

  // 3) CURRENT approach — batch of single getBalance calls. How many fit?
  console.log("  batch of single getBalance calls (current approach):");
  let gbCap = 0;
  for (const n of [1, 10, 50, 100, 200, 500, 1000]) {
    let r;
    try {
      r = await tryGetBalanceBatch(url, n);
    } catch (e) {
      r = { ok: false, why: "throw", sample: e.message };
    }
    console.log(
      `    ${String(n).padStart(5)} addrs → ${r.ok ? "OK" : `REJECT (${r.why}) ${r.sample.slice(0, 90)}`}`,
    );
    if (r.ok) gbCap = n;
  }
  console.log(`    ⇒ up to ${gbCap} native addrs in ONE HTTP request via getBalance batch`);
}
console.log("");
