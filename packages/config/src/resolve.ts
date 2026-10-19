import type { ChecksConfig, DocOpsConfigInput, ResolvedConfig } from "./types.ts";

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge where `override` wins; arrays are replaced, not concatenated. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isObject(base) || !isObject(override)) return (override === undefined ? base : override) as T;
  const out: Obj = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = isObject(value) && isObject(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

export const DEFAULT_CHECKS: ChecksConfig = {
  failOn: "error",
  links: { level: "block", external: { enabled: false, level: "warn", timeoutMs: 5000, concurrency: 8, ignore: [] } },
  coverage: { level: "warn", minimum: 0, measure: "l2", kinds: ["api.operation"], includeDeprecated: false, newEntities: "warn" },
  schemaChange: { level: "block", waiverLabel: "docs-not-needed" },
  drift: { level: "block", changedEntityLevel: "warn", mentions: "contextual", ai: { enabled: false, level: "warn" } },
  docTests: { level: "off", timeoutMs: 30000, languages: ["bash", "sh", "js"] },
  style: { level: "warn", rules: {}, vale: { enabled: "auto", config: ".vale.ini" } },
  a11y: { level: "warn", standard: "wcag22aa" },
  frontmatter: { level: "block", required: ["title"] },
  freshness: { level: "warn", defaultSlaDays: 180, byPageType: {} },
  ownership: { level: "off" },
  secrets: { level: "block" },
  includes: { level: "block" },
};

export function resolveConfig(input: DocOpsConfigInput): ResolvedConfig {
  const jira = input.integrations?.jira;
  return {
    version: 1,
    project: { ...input.project },
    docs: deepMerge(
      {
        root: "docs",
        include: ["**/*.md", "**/*.mdx"],
        exclude: ["**/node_modules/**", "**/_drafts/**"],
        snippets: "_snippets",
        defaultPageType: "guide",
        defaultAudience: "internal",
      },
      input.docs,
    ),
    sources: (input.sources ?? []).map((s) => ({
      visibility: "public" as const,
      ...s,
      reference: { enabled: true, ...s.reference },
    })),
    versions: deepMerge(
      { strategy: "single", tagPattern: "v*", label: "{major}.{minor}", branches: [], keep: 5, default: "latest" },
      input.versions,
    ),
    audiences: input.audiences ?? [],
    checks: deepMerge(DEFAULT_CHECKS, input.checks),
    ownership: deepMerge({ codeowners: "auto", rules: [] }, input.ownership),
    integrations: {
      jira: jira
        ? deepMerge(
            {
              site: jira.site,
              deployment: "cloud",
              projects: [],
              keyPattern: "\\b[A-Z][A-Z0-9_]+-\\d+\\b",
              linkFrom: ["pr_title", "branch_name", "commit_message", "frontmatter"],
              docsRequired: {},
            },
            jira,
          )
        : undefined,
    },
    publish: deepMerge({ environments: [], preview: { enabled: true, ttlDays: 7 } }, input.publish),
    site: deepMerge({ title: input.project.name, lang: "en", theme: {} }, input.site),
    variables: input.variables ?? {},
    ai: deepMerge({ enabled: false, logging: "minimal" }, input.ai),
    plugins: input.plugins ?? [],
  } as ResolvedConfig;
}
