import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  // Target the browser so qrcode's browser build (no pngjs/zlib/Buffer) is used.
  platform: "browser",
  // Bundle these INTO the package so the output has no bare specifiers and
  // works when loaded directly in a browser (and consumers need no extra dep).
  noExternal: ["qrcode", "@noble/hashes"],
  // React is a peer; never bundle it in.
  external: ["react", "react/jsx-runtime"],
});
