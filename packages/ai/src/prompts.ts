import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Effort } from "./gateway/types.ts";

export type PromptId = "answer" | "drift-verify" | "drift-patch" | "release-notes";

export interface PromptTemplate {
  id: string;
  version: string;
  effort: Effort;
  /** The system prompt (template body). */
  text: string;
  purpose: string;
  /** "citations", "markdown", or the JSON Schema the output must match. */
  output: unknown;
}

/** packages/ai/prompts */
export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const cache = new Map<string, PromptTemplate>();

/**
 * Load a versioned template from `packages/ai/prompts/<id>.v<N>.md` (docs/07 §4).
 * Without `version`, the highest N wins. Template ID and version are recorded on
 * every answer and suggestion, so a template file must never change after release:
 * add `<id>.v<N+1>.md` and run the eval instead.
 */
export function loadPrompt(id: PromptId, version?: string | number): PromptTemplate {
  const key = `${id}@${version ?? "latest"}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const pattern = new RegExp(`^${escapeRegExp(id)}\\.v(\\d+)\\.md$`);
  const available = readdirSync(PROMPTS_DIR)
    .map((name) => ({ name, match: pattern.exec(name) }))
    .filter((f): f is { name: string; match: RegExpExecArray } => f.match !== null)
    .map((f) => ({ name: f.name, version: Number(f.match[1]) }))
    .sort((a, b) => b.version - a.version);
  const wanted = version === undefined ? available[0] : available.find((f) => f.version === Number(version));
  if (!wanted) {
    throw new Error(`prompt template ${id}${version === undefined ? "" : `@v${version}`} not found in ${PROMPTS_DIR}`);
  }

  const raw = readFileSync(join(PROMPTS_DIR, wanted.name), "utf8").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${wanted.name}: missing YAML frontmatter`);
  const frontmatter = parseYaml(match[1] ?? "") as Record<string, unknown> | null;
  if (!frontmatter || typeof frontmatter !== "object") throw new Error(`${wanted.name}: frontmatter must be a mapping`);
  if (frontmatter.id !== id) throw new Error(`${wanted.name}: frontmatter id ${String(frontmatter.id)} does not match ${id}`);
  if (String(frontmatter.version) !== String(wanted.version)) {
    throw new Error(`${wanted.name}: frontmatter version ${String(frontmatter.version)} does not match the file name`);
  }
  const effort = frontmatter.effort;
  if (typeof effort !== "string" || !EFFORTS.includes(effort as Effort)) throw new Error(`${wanted.name}: effort must be low, medium or high`);
  if (frontmatter.output === undefined) throw new Error(`${wanted.name}: frontmatter needs an output`);
  const text = (match[2] ?? "").trim();
  if (text.length === 0) throw new Error(`${wanted.name}: empty template body`);

  const template: PromptTemplate = {
    id,
    version: String(wanted.version),
    effort: effort as Effort,
    text,
    purpose: typeof frontmatter.purpose === "string" ? frontmatter.purpose : "",
    output: frontmatter.output,
  };
  cache.set(key, template);
  return template;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$()|[\]\\{}-]/g, "\\$&");
}

/** Replace `{{name}}` placeholders; a placeholder without a value is an error. */
export function renderPrompt(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_whole, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`prompt variable {{${name}}} has no value`);
    return value;
  });
}
