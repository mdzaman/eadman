/**
 * Input validation and Forge-context helpers shared by the resolvers (src/index.ts) and the UI.
 *
 * Everything the browser sends to a resolver (`invoke(name, payload)`) is user input: a user can
 * call a resolver with any payload. These helpers are the gate before a value is placed in a URL
 * path, a query string or a request body sent to DocOps, or before it is stored.
 *
 * Pure and import-free, like view-model.ts, so test/validation.test.ts can run it directly.
 */

/** Same pattern as the `ticketKey` parameter in api/openapi.yaml. */
export const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]+-[0-9]+$/;
/** Jira project keys: uppercase letters, digits and underscores, starting with a letter. */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Caller-chosen idempotency keys: 8 to 128 URL-safe characters (the API allows up to 255). */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_VERSION_NAME_LENGTH = 255;
export const MAX_TICKET_KEYS = 500;
export const MAX_PROJECTS = 200;

export function isIssueKey(value: unknown): value is string {
  return typeof value === "string" && ISSUE_KEY_PATTERN.test(value);
}

export function isProjectKey(value: unknown): value is string {
  return typeof value === "string" && PROJECT_KEY_PATTERN.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/** "PAY-123" -> "PAY". */
export function projectKeyOfIssue(issueKey: string): string {
  return issueKey.slice(0, issueKey.lastIndexOf("-"));
}

function dig(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** A key together with where it came from. */
export interface SourcedKey {
  key: string;
  /**
   * True when the key came from the Forge resolver context, which the platform sets: it is the
   * issue or project the user is looking at, so no further check is needed. False when it came from
   * the caller's payload, which is user input: a user can send any key, so the caller must check
   * that this user may see it before reading anything about it as the app.
   */
  trusted: boolean;
}

/**
 * The issue a resolver call is about, and whether it can be trusted. The Forge resolver `context`
 * is set by the platform (https://developer.atlassian.com/platform/forge/app-context-security/) and
 * wins; the payload is only a fallback. Either way the value must match the issue-key pattern.
 */
export function readIssueKeyWithSource(context: unknown, payload: unknown): SourcedKey | undefined {
  const fromContext = dig(context, "extension", "issue", "key");
  if (isIssueKey(fromContext)) return { key: fromContext, trusted: true };
  const fromPayload = dig(payload, "issueKey");
  return isIssueKey(fromPayload) ? { key: fromPayload, trusted: false } : undefined;
}

/** The Jira project of a project-page call, with the same trust rules as `readIssueKeyWithSource`. */
export function readProjectKeyWithSource(context: unknown, payload: unknown): SourcedKey | undefined {
  const fromContext = dig(context, "extension", "project", "key");
  if (isProjectKey(fromContext)) return { key: fromContext, trusted: true };
  const fromPayload = dig(payload, "project");
  return isProjectKey(fromPayload) ? { key: fromPayload, trusted: false } : undefined;
}

/** `readIssueKeyWithSource` without the source, for callers that authorize the key another way. */
export function readIssueKey(context: unknown, payload: unknown): string | undefined {
  return readIssueKeyWithSource(context, payload)?.key;
}

/** `readProjectKeyWithSource` without the source. */
export function readProjectKey(context: unknown, payload: unknown): string | undefined {
  return readProjectKeyWithSource(context, payload)?.key;
}

/** True when every issue key belongs to the project (PAY-1 belongs to PAY, not to PA or PAYX). */
export function allInProject(issueKeys: readonly string[], projectKey: string): boolean {
  return issueKeys.every((key) => projectKeyOfIssue(key) === projectKey);
}

/** A fix version name as typed or selected: 1 to 255 printable characters. */
export function normalizeVersionName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = stripControlCharacters(value).trim();
  return text.length >= 1 && text.length <= MAX_VERSION_NAME_LENGTH ? text : undefined;
}

/** Search text for `listPages?q=`: trimmed, whitespace collapsed, control characters removed, at most 200 characters. */
export function normalizeSearchQuery(value: unknown): string {
  if (typeof value !== "string") return "";
  return stripControlCharacters(value).replace(/\s+/g, " ").trim().slice(0, MAX_SEARCH_QUERY_LENGTH).trim();
}

/** A client-generated idempotency key, or undefined when absent or malformed (the caller then generates one). */
export function readIdempotencyKey(value: unknown): string | undefined {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value) ? value : undefined;
}

export interface ParsedTicketKeys {
  keys: string[];
  /** True when the input was not an array, was too long or contained anything that is not a ticket key. */
  invalid: boolean;
}

/** Validates the `ticketKeys` of a bulk request; duplicates are dropped. */
export function parseTicketKeys(value: unknown): ParsedTicketKeys {
  if (!Array.isArray(value) || value.length > MAX_TICKET_KEYS) return { keys: [], invalid: true };
  const keys: string[] = [];
  for (const entry of value as unknown[]) {
    if (!isIssueKey(entry)) return { keys: [], invalid: true };
    if (!keys.includes(entry)) keys.push(entry);
  }
  return { keys, invalid: false };
}

export interface ParsedProjectList {
  projects: string[];
  /** Entries that are not valid project keys (after upper-casing). */
  invalid: string[];
}

/** "pay, SEC;ops" -> projects [PAY, SEC, OPS]. Separators: commas, semicolons, whitespace. */
export function parseProjectList(input: string): ParsedProjectList {
  const projects: string[] = [];
  const invalid: string[] = [];
  for (const token of input.split(/[\s,;]+/)) {
    if (token === "") continue;
    const key = token.toUpperCase();
    if (!isProjectKey(key)) {
      if (!invalid.includes(token)) invalid.push(token);
    } else if (!projects.includes(key)) {
      projects.push(key);
    }
  }
  return { projects, invalid };
}

/**
 * A JQL string literal: wrapped in double quotes, with backslash and double quote escaped, so that a
 * value taken from a payload (a fix version name can contain any character) cannot close the quote
 * and add JQL of its own. The callers' inputs have no control characters (normalizeVersionName and
 * the key patterns see to that).
 */
export function jqlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An empty list means "all projects". */
export function isProjectEnabled(enabledProjects: readonly string[], projectKey: string): boolean {
  return enabledProjects.length === 0 || enabledProjects.includes(projectKey);
}

/** A new idempotency key for one user action. `crypto.randomUUID` exists in the Forge UI sandbox and in Node 24. */
export function newIdempotencyKey(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}
