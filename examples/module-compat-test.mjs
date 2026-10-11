// Verify the public package exports as a TypeScript consumer of either format.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), "deposit-watch-modules-"));

try {
  mkdirSync(join(fixture, "node_modules"));
  symlinkSync(root, join(fixture, "node_modules/deposit-watch"), "dir");
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ type: "commonjs" }));
  const source = `
import { getBalances } from "deposit-watch";
import { useDepositWatch } from "deposit-watch/react";
const balances: typeof getBalances = getBalances;
const hook: typeof useDepositWatch = useDepositWatch;
void balances;
void hook;
`;
  writeFileSync(join(fixture, "consumer.cts"), source);
  writeFileSync(join(fixture, "consumer.mts"), source);
  for (const mode of ["Node16", "NodeNext"]) {
    writeFileSync(join(fixture, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "ES2020",
        module: mode,
        moduleResolution: mode,
        strict: true,
        noEmit: true,
        types: [],
      },
      files: ["consumer.cts", "consumer.mts"],
    }));
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", fixture], { stdio: "inherit" });
  }
  for (const [extension, load] of [["cjs", "require"], ["mjs", "import"]]) {
    const runtime = load === "require"
      ? 'const core = require("deposit-watch"); const react = require("deposit-watch/react");'
      : 'import * as core from "deposit-watch"; import * as react from "deposit-watch/react";';
    writeFileSync(join(fixture, `runtime.${extension}`), `${runtime}
import("node:assert/strict").then(({ default: assert }) => {
  assert.equal(typeof core.getBalances, "function");
  assert.equal(typeof react.useDepositWatch, "function");
});`);
    execFileSync(process.execPath, [join(fixture, `runtime.${extension}`)], { stdio: "inherit" });
  }
  console.log("Module compatibility passed: CommonJS and ESM types and runtime exports.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
