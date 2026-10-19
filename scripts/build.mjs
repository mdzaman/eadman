#!/usr/bin/env node
// Bundles the distributable artifacts with esbuild:
//   packages/github-action/dist/index.js  (runs.using: node24, single file, no node_modules)
//   packages/cli/dist/docops.mjs          (npm bin / input for a Node single-executable binary)
import { build } from "esbuild";
import { chmod, stat } from "node:fs/promises";

const requireShim = "import { createRequire as __docopsCreateRequire } from 'node:module'; const require = __docopsCreateRequire(import.meta.url);";
const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  legalComments: "none",
  logLevel: "warning",
  // PGlite/pg are only used by services, never by the CLI or the Action.
  external: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector", "pg"],
};

const targets = [
  { entryPoints: ["packages/github-action/src/main.ts"], outfile: "packages/github-action/dist/index.js", banner: { js: requireShim } },
  { entryPoints: ["packages/cli/src/bin.ts"], outfile: "packages/cli/dist/docops.mjs", banner: { js: requireShim } },
];

for (const target of targets) {
  await build({ ...common, ...target });
  const { size } = await stat(target.outfile);
  console.log(`built ${target.outfile} (${(size / 1024).toFixed(0)} KiB)`);
}
await chmod("packages/cli/dist/docops.mjs", 0o755);
