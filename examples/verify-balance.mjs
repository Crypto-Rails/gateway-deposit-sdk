// Smoke test: hit real public RPCs to confirm the chain adapters decode balances.
// Run: node examples/verify-balance.mjs
import { getBalance } from "../dist/index.js";

// Override with permissive public nodes for CI/Node (defaults are tuned for browsers).
const config = {
  rpcUrls: {
    1: "https://ethereum-rpc.publicnode.com",
    "solana-mainnet": "https://api.mainnet-beta.solana.com",
  },
};

const cases = [
  {
    name: "ETH native (vitalik.eth)",
    target: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chainId: 1 },
  },
  {
    name: "USDC on Ethereum (Circle treasury)",
    target: {
      address: "0x55FE002aefF02F77364de339a1292923A15844B8",
      tokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      chainId: 1,
    },
  },
  {
    name: "SOL native (Binance hot wallet)",
    target: { address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", chainId: "solana-mainnet" },
  },
];

for (const c of cases) {
  try {
    const snap = await getBalance(c.target, config);
    const human =
      snap.decimals != null
        ? (Number(snap.raw) / 10 ** snap.decimals).toLocaleString(undefined, { maximumFractionDigits: 6 })
        : snap.raw.toString();
    console.log(`✓ ${c.name}`);
    console.log(`   raw=${snap.raw}  decimals=${snap.decimals ?? "?"}  symbol=${snap.symbol ?? "-"}  ≈ ${human}`);
  } catch (err) {
    console.log(`✗ ${c.name}\n   ${err.message}`);
  }
}
