// LIVE integration test at scale — 500 real targets per chain, against real
// public RPCs. Proves the batch/multicall paths work on actual nodes, not just
// mocks. For each chain it checks:
//
//   1. Minimal requests over the wire — wrap fetch, assert the batched read of
//      500 targets used the expected minimal number of HTTP requests:
//        · EVM    → 1 real Multicall3 eth_call
//        · Tron   → 5 real Multicall3 eth_call chunks (at most 100 calls each)
//        · Solana → getMultipleAccounts caps at 100 keys/call, so native reads
//          chunk into ceil(native/100) requests + 1 batch for any SPL anchor
//          (this 498-native + 2-SPL layout ⇒ 5 + 1 = 6 requests).
//   2. Correct decode + order   — 3 known-funded "anchor" addresses are planted
//      at indices 0, 250 and 499. Each must come back FUNDED (raw > 0) with the
//      right decimals AT ITS EXACT INDEX. If ordering were shuffled across the
//      500-span, these funded anchors help catch misplaced results. Anchors are also cross-checked against an
//      INDIVIDUAL getBalance() on the same node (the single path is validated
//      against real nodes by verify-balance.mjs), so batch == individual ⇒ the
//      batch decodes the real wire format right.
//   3. Every slot valid         — all 500 results are real bigint snapshots.
//
// The other 497 targets are deterministic, valid-but-unfunded synthetic
// addresses (they read 0). `decimals` is passed on token anchors so the decode
// check is deterministic. A raw-amount difference vs the individual read is a
// warning because live wallets may move between reads; the batch
// intentionally omits the decorative token symbol(). Public endpoints failing
// preflight are skipped; failures after preflight fail the test. NOT part of `npm test` — run on demand:
//   npm run test:live
// Optional dedicated endpoints: TRON_RPC_URL (QuickNode /jsonrpc),
// EVM_RPC_URL, SOLANA_RPC_URL. Set LIVE_CHAIN=tron|evm|solana to run one family.
// A configured endpoint failing preflight is a failure, never a network skip.
import { createHash } from "node:crypto";
import { getBalances, getBalance } from "../dist/index.js";

const N = 500;
const ANCHOR_INDICES = [0, 250, 499];

let failures = 0;
let skips = 0;
let completed = 0;
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
  "0x" +
  (0xdecaf0000000000000000000n + BigInt(i)).toString(16).padStart(40, "0");
const solFiller = (i) => {
  const b = new Uint8Array(32);
  for (let k = 0; k < 32; k++) b[k] = (i * 131 + k * 7 + 1) & 0xff;
  return base58Encode(b); // valid 32-byte pubkey, unfunded → reads 0
};
const tronFiller = (i) => {
  const hex = (0xdecaf0000000000000000000n + BigInt(i)).toString(16).padStart(40, "0");
  const payload = Buffer.from("41" + hex, "hex");
  const sha256 = bytes => createHash("sha256").update(bytes).digest();
  return base58Encode(Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]));
};

const CHAINS = [
  {
    name: "EVM / Multicall3 (Ethereum mainnet)",
    family: "evm",
    rpcKey: 1,
    url: process.env.EVM_RPC_URL ?? "https://ethereum-rpc.publicnode.com",
    configured: !!process.env.EVM_RPC_URL,
    filler: evmFiller,
    anchors: [
      {
        target: {
          address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          chainId: 1,
        },
        decimals: 18,
      },
      {
        target: {
          address: "0x28C6c06298d514Db089934071355E5743bf21d60",
          chainId: 1,
        },
        decimals: 18,
      },
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
    // getMultipleAccounts is honored by mainnet-beta but BLOCKED by publicnode
    // (403), so this live test pins the node for a deterministic request count.
    // The default failover list still works in-SDK (publicnode 403 → retry
    // mainnet-beta), just non-deterministic. Raw caps: solana-cap-probe.mjs.
    name: "Solana / getMultipleAccounts (mainnet)",
    family: "solana",
    rpcKey: "solana-mainnet",
    url: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    configured: !!process.env.SOLANA_RPC_URL,
    filler: solFiller,
    anchors: [
      {
        target: {
          address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
          chainId: "solana-mainnet",
        },
        decimals: 9,
      },
      {
        target: {
          address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          decimals: 6,
          chainId: "solana-mainnet",
        },
        decimals: 6,
      },
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
    name: "Tron / Multicall3 (mainnet)",
    family: "tron",
    rpcKey: "tron-mainnet",
    url: process.env.TRON_RPC_URL ?? "https://tron-evm.publicnode.com/jsonrpc",
    configured: !!process.env.TRON_RPC_URL,
    filler: tronFiller,
    anchors: [
      {
        target: {
          address: "TWd4WrZ9wn84f5x1hZhL4DHvk738ns5jwb",
          chainId: "tron-mainnet",
        },
        decimals: 6,
      },
      {
        target: {
          address: "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax",
          chainId: "tron-mainnet",
        },
        decimals: 6,
      },
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

if (process.env.LIVE_CHAIN && !CHAINS.some(c => c.family === process.env.LIVE_CHAIN)) {
  throw new Error("LIVE_CHAIN must be tron, evm, or solana");
}
for (const chain of CHAINS.filter(c => !process.env.LIVE_CHAIN || c.family === process.env.LIVE_CHAIN)) {
  console.log(`\n── ${chain.name} — ${N} targets ──`);

  // Build 500 synthetic filler targets, then plant anchors at fixed indices.
  const targets = Array.from({ length: N }, (_, i) => ({
    address: chain.filler(i),
    chainId: chain.rpcKey,
  }));
  const anchorAt = new Map();
  chain.anchors.forEach((a, k) => {
    const idx = ANCHOR_INDICES[k];
    targets[idx] = a.target;
    anchorAt.set(idx, a);
  });

  let reqs = 0;
  const payloads = [];
  const fetchFn = async (url, init) => {
    reqs++;
    payloads.push(JSON.parse(init.body));
    return fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  };
  const config = { rpcUrls: { [chain.rpcKey]: chain.url }, fetchFn };

  // Establish reachability before the SDK's best-effort fallback can hide errors.
  try {
    await getBalance(chain.anchors[0].target, config);
  } catch {
    if (chain.configured) ok(false, "configured RPC endpoint failed preflight");
    else { skips++; console.log("  ⚠ SKIP — public RPC endpoint unavailable in preflight"); }
    continue;
  }
  payloads.length = 0;
  let batched;
  let batchReqs = 0;
  const t0 = performance.now();
  try {
    const before = reqs;
    batched = await getBalances(targets, config);
    batchReqs = reqs - before;
  } catch {
    ok(false, "grouped read failed after successful preflight");
    continue;
  }
  const ms = Math.round(performance.now() - t0);

  // EVM uses one aggregate; TRON uses ceil(calls/100) bounded aggregates.
  // Solana's getMultipleAccounts is capped at 100 keys/call, so
  // native reads chunk into ceil(native/100) requests + 1 batch for SPL anchors.
  const tokenCount = targets.filter(
    (t) =>
      t.tokenAddress &&
      !["native", "sol"].includes(String(t.tokenAddress).toLowerCase()),
  ).length;
  const nativeCount = N - tokenCount;
  const expectedReqs =
    chain.family === "solana"
      ? Math.ceil(nativeCount / 100) + (tokenCount > 0 ? 1 : 0)
      : chain.family === "tron" ? Math.ceil(N / 100) : 1;
  const reqShape =
    chain.family === "solana"
      ? `${Math.ceil(nativeCount / 100)} getMultipleAccounts chunk(s)${tokenCount ? " + 1 token batch" : ""}`
      : chain.family === "tron" ? "Multicall3 chunks, ≤100 calls each" : "1 Multicall3 aggregate";

  completed++;
  ok(batchReqs === expectedReqs,
    `${N} targets → ${batchReqs} HTTP request(s), expected ${expectedReqs} [${reqShape}] (${ms}ms)`);
  const failedReads = batched.filter(r => r.error).length;
  ok(failedReads === 0, `${failedReads} failed reads (errors must not masquerade as zero balances)`);
  if (chain.family === "tron") {
    ok(payloads.every(p => !Array.isArray(p) && p.method === "eth_call" &&
      p.params[0].to === "0x32a4f47a74a6810bd0bf861cabab99656a75de9e" &&
      p.params[0].data.startsWith("0x82ad56cb")), "every TRON chunk used the mainnet Multicall3 deployment");
    const sizes = payloads.filter(p => !Array.isArray(p)).map(p =>
      parseInt(p.params[0].data.slice(74, 138), 16));
    ok(sizes.every(n => n > 0 && n <= 100) && sizes.reduce((a, b) => a + b, 0) === N,
      "bounded chunks contain every requested balance exactly once");
  }

  ok(
    batched.length === N,
    `returned ${batched.length} results (expected ${N})`,
  );
  const invalid = batched.filter(
    (r) => typeof r.balance.raw !== "bigint",
  ).length;
  ok(invalid === 0, `every one of ${N} slots is a valid bigint snapshot`);

  // Verify each anchor decoded correctly AT ITS INDEX (proves ordering across 500).
  for (const idx of ANCHOR_INDICES) {
    const a = anchorAt.get(idx);
    const b = batched[idx].balance;
    const label = a.target.tokenAddress
      ? `token ${a.target.tokenAddress.slice(0, 8)}…`
      : "native";
    ok(
      b.raw > 0n,
      `[idx ${idx}] ${label}: funded value landed at its index (raw ${b.raw})`,
    );
    ok(
      b.decimals === a.decimals,
      `[idx ${idx}] ${label}: decimals match (${b.decimals})`,
    );

    // Cross-check the anchor against an individual read on the same node.
    let single;
    try {
      single = await getBalance(a.target, config);
    } catch {
      ok(false, `[idx ${idx}] ${label}: individual cross-check failed after successful preflight`);
      continue;
    }
    ok(
      b.symbol === single.symbol || b.symbol === undefined,
      `[idx ${idx}] ${label}: symbol consistent (batch ${b.symbol ?? "∅"} / single ${single.symbol ?? "∅"})`,
    );
    if (b.raw === single.raw) {
      console.log(
        `  ✓ [idx ${idx}] ${label}: raw matches individual read exactly`,
      );
    } else {
      console.log(
        `  ⚠ [idx ${idx}] ${label}: raw differs (batch ${b.raw} vs single ${single.raw}) — possible balance movement; exact equality was not verified`,
      );
    }
  }

  const nonzero = batched.filter((r) => r.balance.raw > 0n).length;
  console.log(`  · ${nonzero} of ${N} funded (3 anchors + any funded filler)`);
}

console.log("");
if (failures > 0) {
  console.log(
    `${failures} CHECK(S) FAILED${skips ? `, ${skips} skipped` : ""}`,
  );
  process.exit(1);
} else if (completed === 0) {
  console.log(`NO LIVE CHAINS VERIFIED (${skips} network skip(s))`);
  process.exitCode = 2;
} else if (skips > 0) {
  console.log(`${completed} LIVE CHAIN(S) VERIFIED; ${skips} network skip(s)`);
} else {
  console.log("ALL LIVE CHECKS PASSED");
}
