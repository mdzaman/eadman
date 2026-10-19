import type { Level, PageType } from "@docops/core";

/** docops.yaml as written by users (see schema/docops.schema.json). */
export interface DocOpsConfigInput {
  version: 1;
  project: { id: string; name: string; description?: string; repository?: string };
  docs?: Partial<DocsConfig>;
  sources?: SourceConfig[];
  versions?: Partial<VersionsConfig>;
  audiences?: AudienceConfig[];
  checks?: DeepPartial<ChecksConfig>;
  ownership?: Partial<OwnershipConfig>;
  integrations?: { jira?: Partial<JiraConfig> & { site: string } };
  publish?: Partial<PublishConfig>;
  site?: Partial<SiteConfig>;
  variables?: Record<string, string | number | boolean>;
  ai?: Partial<AiConfig>;
  plugins?: Array<{ package: string; options?: Record<string, unknown> }>;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface DocsConfig {
  root: string;
  include: string[];
  exclude: string[];
  snippets: string;
  defaultPageType: PageType;
  defaultAudience: string;
}

export type SourceType =
  | "openapi" | "asyncapi" | "graphql" | "protobuf" | "jsonschema" | "typescript" | "python"
  | "java" | "go" | "csharp" | "rust" | "terraform" | "cloudformation" | "helm" | "kubernetes"
  | "sql" | "custom";

export interface SourceConfig {
  id: string;
  type: SourceType;
  path: string;
  visibility?: "public" | "internal";
  reference?: { enabled?: boolean; outDir?: string; title?: string };
  options?: Record<string, unknown>;
}

export interface VersionsConfig {
  strategy: "single" | "git-tags" | "branches";
  tagPattern: string;
  label: string;
  branches: string[];
  keep: number;
  default: string;
}

export interface AudienceConfig {
  id: string;
  description?: string;
  include?: string[];
  exclude?: string[];
}

export interface ChecksConfig {
  failOn: "error" | "warning" | "never";
  links: { level: Level; external: { enabled: boolean; level: Level; timeoutMs: number; concurrency: number; ignore: string[] } };
  coverage: { level: Level; minimum: number; measure: "l1" | "l2"; kinds: string[]; includeDeprecated: boolean; newEntities: Level };
  schemaChange: { level: Level; waiverLabel: string };
  drift: { level: Level; changedEntityLevel: Level; mentions: "contextual" | "strict" | "off"; ai: { enabled: boolean; level: Level } };
  docTests: { level: Level; timeoutMs: number; languages: string[] };
  style: { level: Level; rules: Record<string, Level>; vale: { enabled: boolean | "auto"; config: string } };
  a11y: { level: Level; standard: "wcag21aa" | "wcag22aa" };
  frontmatter: { level: Level; required: string[] };
  freshness: { level: Level; defaultSlaDays: number; byPageType: Record<string, number> };
  ownership: { level: Level };
  secrets: { level: Level };
  includes: { level: Level };
}

export interface OwnershipConfig {
  codeowners: "auto" | boolean | string;
  rules: Array<{ pattern: string; owners: string[]; slaDays?: number }>;
}

export interface JiraConfig {
  site: string;
  deployment: "cloud" | "data-center";
  projects: string[];
  keyPattern: string;
  linkFrom: Array<"pr_title" | "pr_body" | "branch_name" | "commit_message" | "frontmatter">;
  docsRequired: { field?: string; label?: string; issueTypes?: string[] };
}

export interface PublishConfig {
  baseUrl?: string;
  environments: Array<{ name: string; branch?: string; tags?: string; requireApproval?: boolean; url?: string }>;
  preview: { enabled: boolean; ttlDays: number };
}

export interface SiteConfig {
  title: string;
  logo?: string;
  lang: string;
  editUrl?: string;
  theme: { primaryColor?: string; fontFamily?: string };
}

export interface AiConfig {
  enabled: boolean;
  provider?: "anthropic" | "bedrock" | "vertex" | "azure-openai" | "openai-compatible";
  model?: string;
  logging: "minimal" | "full";
}

/** docops.yaml with every default applied: what the engine consumes. */
export interface ResolvedConfig {
  version: 1;
  project: { id: string; name: string; description?: string | undefined; repository?: string | undefined };
  docs: DocsConfig;
  sources: SourceConfig[];
  versions: VersionsConfig;
  audiences: AudienceConfig[];
  checks: ChecksConfig;
  ownership: OwnershipConfig;
  integrations: { jira?: JiraConfig | undefined };
  publish: PublishConfig;
  site: SiteConfig;
  variables: Record<string, string | number | boolean>;
  ai: AiConfig;
  plugins: Array<{ package: string; options?: Record<string, unknown> | undefined }>;
}

export interface ConfigIssue {
  pointer: string;
  message: string;
  line?: number | undefined;
  column?: number | undefined;
}
