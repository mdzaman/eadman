import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findingFingerprint, levelToSeverity, type Finding, type Level } from "@docops/core";
import type { ParsedPage } from "@docops/markdown";

export interface DocTestResult {
  page: string;
  line: number;
  lang: string;
  passed: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  reason?: string | undefined;
}

const RUNNERS: Record<string, { cmd: string; args: string[] }> = {
  bash: { cmd: "bash", args: ["-eo", "pipefail", "-s"] },
  sh: { cmd: "sh", args: ["-e", "-s"] },
  js: { cmd: process.execPath, args: ["--input-type=module", "-"] },
  javascript: { cmd: process.execPath, args: ["--input-type=module", "-"] },
};

function metaValue(meta: string, key: string): string | undefined {
  return new RegExp(`${key}="([^"]*)"`).exec(meta)?.[1];
}

/**
 * Run fenced code blocks marked `test` (```bash test expect="ok"). This executes repository
 * content, so it is off by default and intended for the customer's own CI (ADR-0010).
 * `{{ name }}` uses docops.yaml variables; `{{ env.NAME }}` reads the CI environment and is never echoed.
 */
export async function runDocTests(
  pages: readonly ParsedPage[],
  options: { languages: readonly string[]; timeoutMs: number; variables: Record<string, string | number | boolean>; env?: NodeJS.ProcessEnv },
): Promise<DocTestResult[]> {
  const results: DocTestResult[] = [];
  const env = options.env ?? process.env;
  for (const page of pages) {
    for (const block of page.codeBlocks) {
      const lang = (block.lang ?? "").toLowerCase();
      if (!block.meta || !/(^|\s)test(\s|$)/.test(block.meta) || !options.languages.includes(lang)) continue;
      const runner = RUNNERS[lang];
      if (!runner) {
        results.push({ page: page.path, line: block.line, lang, passed: false, exitCode: null, stdout: "", stderr: "", durationMs: 0, reason: `no runner for ${lang}` });
        continue;
      }
      const secrets: string[] = [];
      const code = block.value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) => {
        if (name.startsWith("env.")) {
          const value = env[name.slice(4)] ?? "";
          if (value) secrets.push(value);
          return value;
        }
        return name in options.variables ? String(options.variables[name]) : whole;
      });
      const dir = await mkdtemp(join(tmpdir(), "docops-doctest-"));
      const started = Date.now();
      const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
        const child = spawn(runner.cmd, runner.args, { cwd: dir, env: { PATH: env.PATH ?? "", HOME: dir, LANG: "C.UTF-8" } });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs);
        child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(-8000)));
        child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
        child.on("close", (exit) => {
          clearTimeout(timer);
          resolve({ code: exit, stdout, stderr, timedOut });
        });
        child.stdin.end(code);
      });
      await rm(dir, { recursive: true, force: true });
      const redact = (s: string) => secrets.reduce((acc, secret) => acc.replaceAll(secret, "***"), s);
      const expect = metaValue(block.meta, "expect");
      let reason: string | undefined;
      if (outcome.timedOut) reason = `timed out after ${options.timeoutMs} ms`;
      else if (outcome.code !== 0) reason = `exited with code ${outcome.code}`;
      else if (expect !== undefined && !outcome.stdout.includes(expect)) reason = `output did not contain "${expect}"`;
      results.push({
        page: page.path,
        line: block.line,
        lang,
        passed: reason === undefined,
        exitCode: outcome.code,
        stdout: redact(outcome.stdout),
        stderr: redact(outcome.stderr),
        durationMs: Date.now() - started,
        reason,
      });
    }
  }
  return results;
}

export function docTestFindings(results: readonly DocTestResult[], docsRoot: string, level: Level): Finding[] {
  const severity = levelToSeverity(level);
  if (!severity) return [];
  return results
    .filter((r) => !r.passed)
    .map((r) => ({
      ruleId: "doctest/failed",
      category: "doctest",
      severity,
      origin: "deterministic" as const,
      message: `\`${r.lang}\` sample failed: ${r.reason}.${r.stderr ? ` stderr: ${r.stderr.trim().split("\n").slice(-3).join(" | ")}` : ""}`,
      file: `${docsRoot}/${r.page}`,
      line: r.line,
      evidence: { exitCode: r.exitCode, durationMs: r.durationMs },
      fingerprint: findingFingerprint(["doctest/failed", r.page, r.line]),
    }));
}
