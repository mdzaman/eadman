import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import { LineCounter, parseDocument } from "yaml";
import { DocOpsError, sha256Hex } from "@docops/core";
import { resolveConfig } from "./resolve.ts";
import type { ConfigIssue, DocOpsConfigInput, ResolvedConfig } from "./types.ts";
import schema from "../schema/docops.schema.json" with { type: "json" };

// Imported (not read from disk) so bundles such as the GitHub Action stay self-contained.
export const configSchema: Record<string, unknown> = schema as Record<string, unknown>;

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
ajv.addFormat("uri", (value: string) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
});
const validate = ajv.compile(configSchema);

export class ConfigError extends DocOpsError {
  readonly issues: ConfigIssue[];
  readonly file: string;

  constructor(file: string, issues: ConfigIssue[]) {
    super(
      "config_invalid",
      `${file} is invalid:\n${issues.map((i) => `  ${file}${i.line ? `:${i.line}:${i.column ?? 1}` : ""} ${i.pointer || "/"} ${i.message}`).join("\n")}`,
      400,
      issues.map((i) => ({ pointer: i.pointer, message: i.message })),
    );
    this.issues = issues;
    this.file = file;
  }
}

export interface LoadedConfig {
  path: string;
  /** sha256 of the raw file; recorded on snapshots and check runs. */
  digest: string;
  input: DocOpsConfigInput;
  config: ResolvedConfig;
}

function describe(error: ErrorObject): string {
  if (error.keyword === "additionalProperties") {
    return `unknown property "${String((error.params as { additionalProperty: string }).additionalProperty)}"`;
  }
  if (error.keyword === "enum") {
    return `must be one of ${((error.params as { allowedValues: unknown[] }).allowedValues ?? []).map((v) => JSON.stringify(v)).join(", ")}`;
  }
  return error.message ?? error.keyword;
}

/** Validate an already-parsed object against the JSON Schema. */
export function validateConfig(value: unknown): ConfigIssue[] {
  if (validate(value)) return [];
  const seen = new Set<string>();
  const issues: ConfigIssue[] = [];
  for (const error of validate.errors ?? []) {
    // oneOf/anyOf produce noisy sub-errors; keep the most specific message per pointer.
    if (error.keyword === "oneOf" || error.keyword === "anyOf") continue;
    const key = `${error.instancePath}|${describe(error)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ pointer: error.instancePath, message: describe(error) });
  }
  return issues;
}

/** Parse and validate docops.yaml text; errors carry line and column. */
export function parseConfig(text: string, path = "docops.yaml"): LoadedConfig {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  if (doc.errors.length > 0) {
    throw new ConfigError(
      path,
      doc.errors.map((e) => {
        const pos = lineCounter.linePos(e.pos[0]);
        return { pointer: "", message: e.message.split("\n")[0] ?? e.message, line: pos.line, column: pos.col };
      }),
    );
  }
  const value = doc.toJS({ maxAliasCount: 50 }) as unknown;
  const issues = validateConfig(value).map((issue) => {
    const segments = issue.pointer.split("/").slice(1).map((s) => (/^\d+$/.test(s) ? Number(s) : s.replaceAll("~1", "/").replaceAll("~0", "~")));
    const node = doc.getIn(segments, true) as { range?: [number, number, number] } | undefined;
    const offset = node?.range?.[0];
    if (offset === undefined) return issue;
    const pos = lineCounter.linePos(offset);
    return { ...issue, line: pos.line, column: pos.col };
  });
  if (issues.length > 0) throw new ConfigError(path, issues);
  const input = value as DocOpsConfigInput;
  return { path, digest: sha256Hex(text), input, config: resolveConfig(input) };
}

export async function loadConfig(cwd: string, file = "docops.yaml"): Promise<LoadedConfig> {
  const path = file.startsWith("/") ? file : join(cwd, file);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ConfigError(file, [{ pointer: "", message: `configuration file not found (run "docops init")` }]);
  }
  return parseConfig(text, file);
}
