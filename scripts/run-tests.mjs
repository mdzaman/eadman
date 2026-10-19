#!/usr/bin/env node
// Runs every *.test.ts with Node's built-in test runner and native TypeScript type stripping.
// Usage: npm test [-- <path-substring> ...]   e.g. npm test -- engine api/test/webhooks
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const filters = process.argv.slice(2);
const files = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (name.endsWith(".test.ts")) files.push(relative(root, full));
  }
}
for (const base of ["packages", "apps"]) walk(join(root, base));

const selected = files
  .filter((f) => f.split("/").includes("test"))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();
if (selected.length === 0) {
  console.error("No test files matched", filters);
  process.exit(1);
}
const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--test", ...selected],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
