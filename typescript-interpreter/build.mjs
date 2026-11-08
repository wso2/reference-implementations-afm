import { build } from "esbuild";

await build({
  entryPoints: ["packages/runtime/src/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: process.argv[2] ?? "dist/main.js",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
