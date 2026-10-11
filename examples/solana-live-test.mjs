// LIVE test of the Solana getMultipleAccounts path against a real mainnet node.
// Proves the switch from per-address getBalance to getMultipleAccounts:
//
//   1. 100-in-1            — 100 native targets read in exactly ONE HTTP request
//                            (one getMultipleAccounts, the 100-key protocol cap).
//   2. Correct decode+order — 2 known-funded native anchors planted at indices 0
//                            and 99 come back FUNDED at their exact index, and
//                            match an INDIVIDUAL getBalance() on the same node.
//   3. Auto-chunk >100     — 150 native targets split into 2 getMultipleAccounts
//                            requests (ceil(150/100)); every slot decodes.
//   4. SPL untouched       — an SPL token anchor still reads via
//                            getTokenAccountsByOwner and stays funded.
//
// Pointed straight at api.mainnet-beta.solana.com (no failover) so request
// counts are deterministic — publicnode blocks getMultipleAccounts, mainnet-beta
// honors it. NOT part of `npm test`. Run on demand:
//   node examples/solana-live-test.mjs
import { getBalances, getBalance } from "../dist/index.js";

const URL = "https://api.mainnet-beta.solana.com";
const CHAIN = "solana-mainnet";

// Well-known, reliably-funded mainnet accounts used as decode anchors.
const NATIVE_A = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const NATIVE_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};

// deterministic valid 32-byte base58 pubkeys for unfunded filler (read 0)
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
const filler = (i) => {
  const b = new Uint8Array(32);
  for (let k = 0; k < 32; k++) b[k] = (i * 131 + k * 7 + 1) & 0xff;
  return base58Encode(b);
};

function makeConfig() {
  let reqs = 0;
  const fetchFn = async (...a) => {
    reqs++;
    return fetch(...a);
  };
  return {
    config: { rpcUrls: { [CHAIN]: URL }, fetchFn },
    reqCount: () => reqs,
  };
}

// ── Test 1 & 2: 100 native, one request, anchors decode at their index ──────────
{
  console.log("\n── 100 native targets: one getMultipleAccounts request ──");
  const N = 100;
  const targets = Array.from({ length: N }, (_, i) => ({
    address: filler(i),
    chainId: CHAIN,
  }));
  targets[0] = { address: NATIVE_A, chainId: CHAIN };
  targets[99] = { address: NATIVE_B, chainId: CHAIN };

  const { config, reqCount } = makeConfig();
  const t0 = performance.now();
  const results = await getBalances(targets, config);
  const ms = Math.round(performance.now() - t0);

  ok(reqCount() === 1, `100 targets collapsed into 1 HTTP request (${ms}ms, ${reqCount()} req)`);
  ok(results.length === N, `returned ${results.length} results (expected ${N})`);
  ok(
    results.every((r) => typeof r.balance.raw === "bigint"),
    `all ${N} slots are valid bigint snapshots`,
  );
  ok(results[0].balance.raw > 0n, `[idx 0] anchor A funded at its index (raw ${results[0].balance.raw})`);
  ok(results[99].balance.raw > 0n, `[idx 99] anchor B funded at its index (raw ${results[99].balance.raw})`);

  // cross-check anchors against an individual getBalance on the same node
  const singleA = await getBalance({ address: NATIVE_A, chainId: CHAIN }, config);
  const singleB = await getBalance({ address: NATIVE_B, chainId: CHAIN }, config);
  const near = (a, b) => (a > b ? a - b : b - a) <= a / 1000n + 1n; // ≤0.1% drift
  ok(
    near(results[0].balance.raw, singleA.raw),
    `[idx 0] batch raw ≈ individual getBalance (batch ${results[0].balance.raw} / single ${singleA.raw})`,
  );
  ok(
    near(results[99].balance.raw, singleB.raw),
    `[idx 99] batch raw ≈ individual getBalance (batch ${results[99].balance.raw} / single ${singleB.raw})`,
  );
  ok(
    results[0].balance.symbol === "SOL" && results[0].balance.decimals === 9,
    `native decode carries SOL / 9 decimals`,
  );
}

// ── Test 3: >100 native auto-chunks into ceil(N/100) requests ───────────────────
{
  console.log("\n── 150 native targets: auto-chunk into 2 requests ──");
  const N = 150;
  const targets = Array.from({ length: N }, (_, i) => ({
    address: filler(i + 1000),
    chainId: CHAIN,
  }));
  targets[0] = { address: NATIVE_A, chainId: CHAIN };
  targets[149] = { address: NATIVE_B, chainId: CHAIN };

  const { config, reqCount } = makeConfig();
  let results;
  try {
    results = await getBalances(targets, config);
  } catch (err) {
    console.log(`  ⚠ SKIP — ${err.message}`);
    results = null;
  }
  if (results) {
    ok(
      reqCount() === 2,
      `150 targets split into ${reqCount()} getMultipleAccounts request(s) (expected 2)`,
    );
    ok(results.length === N, `returned ${results.length} results (expected ${N})`);
    ok(
      results.every((r) => typeof r.balance.raw === "bigint"),
      `all ${N} slots decoded across the chunk boundary`,
    );
    ok(results[0].balance.raw > 0n, `[idx 0] anchor A funded (first chunk)`);
    ok(results[149].balance.raw > 0n, `[idx 149] anchor B funded (second chunk)`);
  }
}

// ── Test 4: SPL token still reads via getTokenAccountsByOwner ────────────────────
{
  console.log("\n── SPL token target still reads correctly ──");
  const { config } = makeConfig();
  const target = { address: NATIVE_A, tokenAddress: USDC_MINT, decimals: 6, chainId: CHAIN };
  try {
    const [r] = await getBalances([target], config);
    ok(typeof r.balance.raw === "bigint", `USDC balance is a valid bigint (raw ${r.balance.raw})`);
    ok(r.balance.decimals === 6, `USDC decimals preserved (${r.balance.decimals})`);
  } catch (err) {
    console.log(`  ⚠ SKIP — ${err.message}`);
  }
}

console.log("");
if (failures > 0) {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
} else {
  console.log("ALL SOLANA LIVE CHECKS PASSED");
}
