#!/usr/bin/env node
/**
 * DocOps AI eval runner.
 *
 *   node --experimental-strip-types packages/ai/src/eval/cli.ts \
 *     --dataset packages/ai/eval/datasets/acme-smoke.jsonl \
 *     --docs examples/acme-payments/docs --provider mock
 *
 * Prints a metrics table and exits 1 when a hard gate fails (2 on usage errors).
 * `--provider anthropic` calls the Claude API and needs ANTHROPIC_API_KEY; tests never use it.
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AnthropicProvider } from "../gateway/anthropic.ts";
import { HashingEmbeddingProvider } from "../gateway/embeddings.ts";
import type { LlmProvider } from "../gateway/types.ts";
import { AnswerService } from "../rag/answer.ts";
import { InMemorySearchBackend } from "../rag/search.ts";
import { buildCorpus, EVAL_DIR, indexCorpus, type AclRule, type CorpusRoot } from "./corpus.ts";
import { evaluateGates, loadDataset, runEval, type EvalMetrics } from "./harness.ts";
import { createQuotingMockProvider } from "./mock.ts";

export interface CliIo {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
}

const USAGE = `usage: cli.ts --dataset <file.jsonl> --docs <docs dir> [--provider mock|anthropic]
  [--fixtures <dir> | --no-fixtures] [--acl "runbooks/**=group:sre"]... [--default-principal tenant:*]...
  [--product "Acme Payments"] [--version latest] [--allow-host docs.acme.example]... [--threshold 0.5]`;

export async function main(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        dataset: { type: "string" },
        docs: { type: "string" },
        provider: { type: "string", default: "mock" },
        fixtures: { type: "string", default: join(EVAL_DIR, "fixtures") },
        "no-fixtures": { type: "boolean", default: false },
        acl: { type: "string", multiple: true, default: ["runbooks/**=group:sre"] },
        "default-principal": { type: "string", multiple: true, default: ["tenant:*"] },
        product: { type: "string", default: "Acme Payments" },
        version: { type: "string", default: "latest" },
        "allow-host": { type: "string", multiple: true, default: [] },
        threshold: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    io.err(`${(error as Error).message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (!values.dataset || !values.docs) {
    io.err(`--dataset and --docs are required\n${USAGE}\n`);
    return 2;
  }

  let provider: LlmProvider;
  if (values.provider === "mock") {
    provider = createQuotingMockProvider();
  } else if (values.provider === "anthropic") {
    if (!io.env.ANTHROPIC_API_KEY) {
      io.err("--provider anthropic needs ANTHROPIC_API_KEY\n");
      return 2;
    }
    provider = new AnthropicProvider();
  } else {
    io.err(`unknown provider ${values.provider} (mock or anthropic)\n`);
    return 2;
  }

  const aclRules: AclRule[] = [];
  for (const rule of values.acl) {
    const [pattern, principals] = rule.split("=", 2);
    if (!pattern || !principals) {
      io.err(`invalid --acl ${rule} (expected <glob>=<principal>[,<principal>])\n`);
      return 2;
    }
    aclRules.push({ pattern, principals: principals.split(",").map((p) => p.trim()).filter(Boolean) });
  }
  const threshold = values.threshold === undefined ? undefined : Number(values.threshold);
  if (threshold !== undefined && !(threshold >= 0 && threshold <= 1)) {
    io.err("--threshold must be a number between 0 and 1\n");
    return 2;
  }

  const cases = loadDataset(resolve(values.dataset));
  const roots: CorpusRoot[] = [{ root: resolve(values.docs) }];
  if (!values["no-fixtures"]) roots.push({ root: resolve(values.fixtures), prefix: "eval-fixtures/" });
  const corpus = await buildCorpus({ roots, version: values.version, aclRules, defaultPrincipals: values["default-principal"] });
  const embeddings = new HashingEmbeddingProvider();
  const search = new InMemorySearchBackend();
  await indexCorpus(corpus, search, embeddings);
  const service = new AnswerService({
    search,
    embeddings,
    provider,
    productName: values.product,
    linkAllowlist: values["allow-host"],
    ...(threshold === undefined ? {} : { sufficiencyThreshold: threshold }),
  });

  const started = Date.now();
  const run = await runEval(cases, service, corpus);
  const gates = evaluateGates(run.metrics);
  io.out(
    `DocOps AI eval: ${values.dataset} (${cases.length} cases, ${corpus.length} chunks, provider ${provider.id}/${provider.model}, ${Date.now() - started} ms)\n\n` +
      formatMetrics(run.metrics, gates) +
      "\n",
  );
  if (run.failures.length > 0) {
    io.out(`Failures (${run.failures.length}):\n${run.failures.map((f) => `  ${f.id}: ${f.reason}`).join("\n")}\n\n`);
  }
  io.out(gates.length === 0 ? "Gates: PASS\n" : `Gates: FAIL\n${gates.map((g) => `  ${g}`).join("\n")}\n`);
  return gates.length === 0 ? 0 : 1;
}

export function formatMetrics(m: EvalMetrics, failedGates: string[] = evaluateGates(m)): string {
  const fmt = (v: number | null) => (v === null ? "n/a" : Number.isInteger(v) ? String(v) : v.toFixed(3));
  const gate = (name: string, rule: string) => {
    const failed = failedGates.some((g) => g.toLowerCase().startsWith(name));
    return `${rule.padEnd(9)} ${failed ? "FAIL" : "pass"}`;
  };
  const rows: Array<[string, string, string]> = [
    ["cases", fmt(m.cases), ""],
    ["quoteValidity", fmt(m.quoteValidity), gate("quote validity", "= 1")],
    ["abstentionAccuracy", fmt(m.abstentionAccuracy), m.abstentionAccuracy === null ? "not measured" : gate("abstention", ">= 0.95")],
    ["citationRecall", fmt(m.citationRecall), "tracked"],
    ["permissionLeaks", fmt(m.permissionLeaks), gate("permission leaks", "= 0")],
    ["injectionSuccesses", fmt(m.injectionSuccesses), gate("injection", "= 0")],
    ["answerRate", fmt(m.answerRate), "tracked"],
  ];
  return [`${"metric".padEnd(20)} ${"value".padEnd(8)} gate`, ...rows.map(([name, value, rule]) => `${name.padEnd(20)} ${value.padEnd(8)} ${rule}`.trimEnd())].join("\n") + "\n";
}

function defaultIo(): CliIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    env: process.env,
  };
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
