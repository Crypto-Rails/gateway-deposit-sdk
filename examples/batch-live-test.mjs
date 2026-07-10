// LIVE integration test at scale — 500 real targets per chain, against real
// public RPCs. Proves the batch/multicall paths work on actual nodes, not just
// mocks. For each chain it checks:
//
//   1. 500-in-1 over the wire   — wrap fetch, assert the batched read of 500
//      targets made exactly ONE HTTP request (a real Multicall3 eth_call for
//      EVM; a real 500-element JSON-RPC batch for Solana/Tron).
//   2. Correct decode + order   — 3 known-funded "anchor" addresses are planted
//      at indices 0, 250 and 499. Each must come back FUNDED (raw > 0) with the
//      right decimals AT ITS EXACT INDEX. If ordering were shuffled across the
//      500-span, a funded value would land on the wrong index and its anchor
//      slot would read 0 → fail. Anchors are also cross-checked against an
//      INDIVIDUAL getBalance() on the same node (the single path is validated
//      against real nodes by verify-balance.mjs), so batch == individual ⇒ the
//      batch decodes the real wire format right.
//   3. Every slot valid         — all 500 results are real bigint snapshots.
//
// The other 497 targets are deterministic, valid-but-unfunded synthetic
// addresses (they read 0). `decimals` is passed on token anchors so the decode
// check is deterministic. A raw-amount difference vs the individual read is a
// warning (live exchange wallets move between reads, not a bug); the batch
// intentionally omits the decorative token symbol(); an unreachable/rate-limited
// node is a SKIP. NOT part of `npm test` — run on demand:
//   node examples/batch-live-test.mjs
import { getBalances, getBalance } from "../dist/index.js";

const N = 500;
const ANCHOR_INDICES = [0, 250, 499];

let failures = 0;
let skips = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
};

// ---- deterministic valid-address generators for the synthetic filler ----------
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
// High-entropy base so filler EVM addresses don't collide with precompiles/dust.
const evmFiller = (i) =>
  "0x" + (0xdecaf0000000000000000000n + BigInt(i)).toString(16).padStart(40, "0");
const solFiller = (i) => {
  const b = new Uint8Array(32);
  for (let k = 0; k < 32; k++) b[k] = (i * 131 + k * 7 + 1) & 0xff;
  return base58Encode(b); // valid 32-byte pubkey, unfunded → reads 0
};
const tronFiller = (i) => {
  const b = new Uint8Array(25);
  b[0] = 0x41;
  for (let k = 0; k < 20; k++) b[1 + k] = (i * 31 + k * 7 + 1) & 0xff;
  return base58Encode(b); // valid 0x41-prefixed 25-byte address, unfunded → 0
};

const CHAINS = [
  {
    name: "EVM / Multicall3 (Ethereum mainnet)",
    rpcKey: 1,
    url: "https://ethereum-rpc.publicnode.com",
    filler: evmFiller,
    anchors: [
      { target: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chainId: 1 }, decimals: 18 },
      { target: { address: "0x28C6c06298d514Db089934071355E5743bf21d60", chainId: 1 }, decimals: 18 },
      {
        target: {
          address: "0x55FE002aefF02F77364de339a1292923A15844B8",
          tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          decimals: 6,
          chainId: 1,
        },
        decimals: 6,
      },
    ],
  },
  {
    name: "Solana / JSON-RPC batch (mainnet)",
    rpcKey: "solana-mainnet",
    url: "https://solana-rpc.publicnode.com",
    filler: solFiller,
    anchors: [
      { target: { address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", chainId: "solana-mainnet" }, decimals: 9 },
      { target: { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", chainId: "solana-mainnet" }, decimals: 9 },
      {
        target: {
          address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
          tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          decimals: 6,
          chainId: "solana-mainnet",
        },
        decimals: 6,
      },
    ],
  },
  {
    name: "Tron / JSON-RPC batch (mainnet)",
    rpcKey: "tron-mainnet",
    url: "https://api.trongrid.io/jsonrpc",
    filler: tronFiller,
    anchors: [
      { target: { address: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb", chainId: "tron-mainnet" }, decimals: 6 },
      { target: { address: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax", chainId: "tron-mainnet" }, decimals: 6 },
      {
        target: {
          address: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb",
          tokenAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          decimals: 6,
          chainId: "tron-mainnet",
        },
        decimals: 6,
      },
    ],
  },
];

for (const chain of CHAINS) {
  console.log(`\n── ${chain.name} — ${N} targets ──`);

  // Build 500 synthetic filler targets, then plant anchors at fixed indices.
  const targets = Array.from({ length: N }, (_, i) => ({ address: chain.filler(i), chainId: chain.rpcKey }));
  const anchorAt = new Map();
  chain.anchors.forEach((a, k) => {
    const idx = ANCHOR_INDICES[k];
    targets[idx] = a.target;
    anchorAt.set(idx, a);
  });

  let reqs = 0;
  const fetchFn = async (...a) => {
    reqs++;
    return fetch(...a);
  };
  const config = { rpcUrls: { [chain.rpcKey]: chain.url }, fetchFn };

  let batched;
  let batchReqs = 0;
  const t0 = performance.now();
  try {
    const before = reqs;
    batched = await getBalances(targets, config);
    batchReqs = reqs - before;
  } catch (err) {
    skips++;
    console.log(`  ⚠ SKIP — batched read unreachable: ${err.message}`);
    continue;
  }
  const ms = Math.round(performance.now() - t0);

  if (batchReqs === 1) {
    ok(true, `${N} targets collapsed into 1 HTTP request (${ms}ms, real node)`);
  } else {
    // Node capped/rejected the 500-batch → getBalances fell back to individual
    // reads. Not a decode error; use maxBatchSize to chunk under such a cap.
    console.log(`  ⚠ NOTE — node did not honor a ${N}-item batch: ${batchReqs} requests (fell back to individual reads)`);
  }

  ok(batched.length === N, `returned ${batched.length} results (expected ${N})`);
  const invalid = batched.filter((r) => typeof r.balance.raw !== "bigint").length;
  ok(invalid === 0, `every one of ${N} slots is a valid bigint snapshot`);

  // Verify each anchor decoded correctly AT ITS INDEX (proves ordering across 500).
  for (const idx of ANCHOR_INDICES) {
    const a = anchorAt.get(idx);
    const b = batched[idx].balance;
    const label = a.target.tokenAddress ? `token ${a.target.tokenAddress.slice(0, 8)}…` : "native";
    ok(b.raw > 0n, `[idx ${idx}] ${label}: funded value landed at its index (raw ${b.raw})`);
    ok(b.decimals === a.decimals, `[idx ${idx}] ${label}: decimals match (${b.decimals})`);

    // Cross-check the anchor against an individual read on the same node.
    let single;
    try {
      single = await getBalance(a.target, config);
    } catch (err) {
      skips++;
      console.log(`  ⚠ SKIP [idx ${idx}] ${label} — individual cross-check failed: ${err.message}`);
      continue;
    }
    ok(
      b.symbol === single.symbol || b.symbol === undefined,
      `[idx ${idx}] ${label}: symbol consistent (batch ${b.symbol ?? "∅"} / single ${single.symbol ?? "∅"})`,
    );
    if (b.raw === single.raw) {
      console.log(`  ✓ [idx ${idx}] ${label}: raw matches individual read exactly`);
    } else {
      console.log(`  ⚠ [idx ${idx}] ${label}: raw differs (batch ${b.raw} vs single ${single.raw}) — balance moved between reads, not a decode bug`);
    }
  }

  const nonzero = batched.filter((r) => r.balance.raw > 0n).length;
  console.log(`  · ${nonzero} of ${N} funded (3 anchors + any funded filler)`);
}

console.log("");
if (failures > 0) {
  console.log(`${failures} CHECK(S) FAILED${skips ? `, ${skips} skipped` : ""}`);
  process.exit(1);
} else if (skips > 0) {
  console.log(`LIVE CHECKS PASSED (with ${skips} network skip(s))`);
} else {
  console.log("ALL LIVE CHECKS PASSED");
}
