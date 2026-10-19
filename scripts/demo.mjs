#!/usr/bin/env node
// `npm run demo`: replays the canonical drift scenario in a temporary git repository.
// main = examples/acme-payments; feature branch = renames PaymentCreate.amount → amount_cents,
// adds GET /v1/refunds/{refund_id}, and doubles a config default, without touching docs.
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../packages/git/src/index.ts";
import { acmeHeadConfigSchema, acmeHeadOpenApi } from "../packages/engine/test/fixtures.ts";
import { main } from "../packages/cli/src/main.ts";

const dir = mkdtempSync(join(tmpdir(), "docops-demo-"));
cpSync(new URL("../examples/acme-payments", import.meta.url).pathname, dir, { recursive: true });
const run = (...args) => git(dir, ["-c", "user.name=Dana", "-c", "user.email=dana@acme.example", "-c", "commit.gpgsign=false", ...args]);
await run("init", "-q", "-b", "main");
await run("add", ".");
await run("commit", "-q", "-m", "PAY-100 initial docs");
await run("checkout", "-q", "-b", "feature/PAY-131-amount-cents");
writeFileSync(join(dir, "api/openapi.yaml"), acmeHeadOpenApi());
writeFileSync(join(dir, "config/schema.json"), acmeHeadConfigSchema());
await run("commit", "-qam", "PAY-131 rename amount to amount_cents");
console.log(`$ cd ${dir} && docops check --base main\n`);
const code = await main(["check", "--base", "main", ...process.argv.slice(2)], { cwd: dir, env: process.env, stdout: process.stdout, stderr: process.stderr, fetch, color: Boolean(process.stdout.isTTY), now: () => new Date() });
console.log(`\nexit code ${code} (1 = gate failed; try: npm run demo -- --format markdown)`);
