/**
 * Shared domain model for the DocOps content graph. These types are the contract
 * between the CLI, the engine, the API and the workers (see docs/03-data-model.md).
 */

export type Visibility = "public" | "internal" | "deprecated";

/** Well-known entity kinds. Extractors may emit additional dotted kinds. */
export type EntityKind =
  | "api.operation"
  | "api.parameter"
  | "api.schema"
  | "api.property"
  | "config.key"
  | "cli.command"
  | "cli.flag"
  | "event.message"
  | (string & {});

/** One thing that documentation describes, extracted from a source at a commit. */
export interface EntityDefinition {
  /** `{kind}:{sourceKey}:{localName}`, stable across commits. */
  key: string;
  kind: EntityKind;
  /** Human name (operationId, property name, config key). */
  name: string;
  sourceKey: string;
  parentKey?: string | undefined;
  visibility: Visibility;
  /** Normalized, comparable attributes (no presentation-only fields). */
  attributes: Record<string, unknown>;
  /** Strings used to detect mentions in prose and code. */
  surfaceForms: string[];
  /** Keys of related entities (an operation's request/response schemas). Used for contextual mentions. */
  related?: string[] | undefined;
  /** sha256 of the canonical JSON of `attributes`. */
  fingerprint: string;
  /** Where the definition lives, for findings that point at the source. */
  location?: { file: string; line?: number | undefined } | undefined;
}

export interface AttributeDelta {
  path: string;
  before: unknown;
  after: unknown;
}

export type EntityChangeType = "added" | "removed" | "modified" | "renamed";

export interface EntityChange {
  type: EntityChangeType;
  key: string;
  kind: EntityKind;
  before?: EntityDefinition | undefined;
  after?: EntityDefinition | undefined;
  /** For `renamed`: the key of the entity it became. */
  renamedTo?: string | undefined;
  deltas: AttributeDelta[];
  breaking: boolean;
  /** False for description-only or internal changes; such changes never gate. */
  userVisible: boolean;
}

export type ReferenceKind = "explicit" | "link" | "mention" | "code_sample" | "generated";

/** A page -> entity edge produced by the reference index. */
export interface DocReference {
  pagePath: string;
  entityKey: string;
  kind: ReferenceKind;
  line?: number | undefined;
  /** 0..1, see docs/07-ai-design.md §3.3 */
  confidence: number;
  /** Fingerprint of the entity definition the page was written against. */
  entityFingerprint: string;
  /** The text that matched (surface form), when the reference came from prose or code. */
  matchedText?: string | undefined;
}

export type Level = "off" | "warn" | "block";
export type Severity = "info" | "warning" | "error";
export type FindingOrigin = "deterministic" | "ai";

export interface FindingSuggestion {
  kind: "replacement" | "patch";
  /** 1-based line the replacement applies to. */
  line?: number | undefined;
  /** Complete replacement text for `line`. */
  replacement?: string | undefined;
  /** The current text of `line` (shown as the "-" side of the suggested diff). */
  original?: string | undefined;
  /** Unified diff (AI patches). */
  patch?: string | undefined;
  aiSuggestionId?: string | undefined;
}

export interface Finding {
  ruleId: string;
  category: string;
  severity: Severity;
  origin: FindingOrigin;
  message: string;
  file?: string | undefined;
  line?: number | undefined;
  endLine?: number | undefined;
  entityKey?: string | undefined;
  evidence: Record<string, unknown>;
  suggestion?: FindingSuggestion | undefined;
  /** Stable across runs: dismissals and lifecycle are keyed by it. */
  fingerprint: string;
}

export type PageType =
  | "guide"
  | "how_to"
  | "tutorial"
  | "concept"
  | "reference"
  | "generated_reference"
  | "runbook"
  | "adr"
  | "postmortem"
  | "release_notes"
  | "onboarding"
  | "snippet"
  | "other";

export type DocsStatus = "not_required" | "missing" | "in_review" | "merged" | "published" | "stale";
export type DocsRequired = "yes" | "no" | "unknown";

export type LinkSource =
  | "frontmatter"
  | "pr_title"
  | "pr_body"
  | "branch_name"
  | "commit_message"
  | "tracker_panel"
  | "api"
  | "inferred";

export interface CoverageCounts {
  publicEntities: number;
  documentedL1: number;
  documentedL2: number;
  percentL1: number;
  percentL2: number;
}

export interface CoverageReport {
  totals: CoverageCounts;
  byKind: Array<CoverageCounts & { kind: string }>;
  undocumented: Array<{ key: string; kind: string }>;
}

export interface CheckSummary {
  counts: { error: number; warning: number; info: number };
  byCategory: Record<string, number>;
  coverage?: { percentL1?: number; percentL2?: number } | undefined;
  gate: { blocked: boolean; reasons: string[] };
}

/** The machine-readable report (`docops.report.v1`) produced by `docops check`. */
export interface CheckReport {
  schema: "docops.report.v1";
  tool: { name: "docops"; version: string };
  project: { id: string; repository?: string | undefined };
  base?: { ref: string; sha: string | null } | undefined;
  head: { ref: string; sha: string | null };
  summary: CheckSummary;
  changes: Array<{
    entityKey: string;
    type: EntityChangeType;
    to?: string | undefined;
    breaking: boolean;
    userVisible: boolean;
  }>;
  findings: Finding[];
  coverage?: CoverageReport | undefined;
  stats: { pages: number; entities: number; references: number; durationMs: number };
}
