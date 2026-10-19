import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { Finding } from "@docops/core";

// ---------------------------------------------------------------------------- webhooks

/** Verify `X-Hub-Signature-256: sha256=<hex>` over the raw body (constant-time). */
export function verifyGithubSignature(secret: string, rawBody: string | Uint8Array, header: string | null | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(rawBody).digest("hex"), "utf8");
  const given = Buffer.from(header.slice(7), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signGithubPayload(secret: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

// ---------------------------------------------------------------------------- REST client

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string | undefined; // https://api.github.com or https://ghes.example.com/api/v3
  fetch?: typeof fetch | undefined;
  userAgent?: string | undefined;
}

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  message: string;
  title?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class GitHubClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: GitHubClientOptions) {
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.userAgent = options.userAgent ?? "docops/0.1";
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": this.userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new GitHubApiError(response.status, `${method} ${path} -> ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Create or update the single DocOps summary comment on a PR (found by hidden marker). */
  async upsertStickyComment(owner: string, repo: string, issueNumber: number, body: string, marker: string): Promise<{ id: number; created: boolean }> {
    for (let page = 1; page <= 10; page++) {
      const comments = await this.request<Array<{ id: number; body?: string }>>("GET", `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
      const existing = comments.find((c) => c.body?.includes(marker));
      if (existing) {
        await this.request("PATCH", `/repos/${owner}/${repo}/issues/comments/${existing.id}`, { body });
        return { id: existing.id, created: false };
      }
      if (comments.length < 100) break;
    }
    const created = await this.request<{ id: number }>("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    return { id: created.id, created: true };
  }

  /** Create a completed check run; annotations are sent in batches of 50 (API limit per request). */
  async createCheckRun(args: {
    owner: string;
    repo: string;
    name: string;
    headSha: string;
    conclusion: "success" | "failure" | "neutral";
    title: string;
    summary: string;
    text?: string | undefined;
    annotations: CheckRunAnnotation[];
    detailsUrl?: string | undefined;
    externalId?: string | undefined;
  }): Promise<{ id: number; requests: number }> {
    const limit = (s: string) => (s.length > 65_000 ? `${s.slice(0, 64_900)}\n\n…truncated` : s);
    const batches: CheckRunAnnotation[][] = [];
    for (let i = 0; i < args.annotations.length; i += 50) batches.push(args.annotations.slice(i, i + 50));
    const output = (annotations: CheckRunAnnotation[]) => ({ title: args.title, summary: limit(args.summary), text: args.text ? limit(args.text) : undefined, annotations });
    const created = await this.request<{ id: number }>("POST", `/repos/${args.owner}/${args.repo}/check-runs`, {
      name: args.name,
      head_sha: args.headSha,
      status: "completed",
      conclusion: args.conclusion,
      details_url: args.detailsUrl,
      external_id: args.externalId,
      output: output(batches[0] ?? []),
    });
    for (const batch of batches.slice(1)) {
      await this.request("PATCH", `/repos/${args.owner}/${args.repo}/check-runs/${created.id}`, { output: output(batch) });
    }
    return { id: created.id, requests: Math.max(1, batches.length) };
  }

  /** Inline review comment carrying a one-click ```suggestion. */
  async createSuggestion(args: { owner: string; repo: string; pullNumber: number; commitId: string; path: string; line: number; replacement: string; note: string; fingerprint?: string }): Promise<void> {
    await this.request("POST", `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/comments`, {
      commit_id: args.commitId,
      path: args.path,
      line: args.line,
      side: "RIGHT",
      body: suggestionBody(args.note, args.replacement, args.fingerprint),
    });
  }

  async listReviewComments(owner: string, repo: string, pullNumber: number): Promise<Array<{ id: number; body: string; path: string; line: number | null }>> {
    const comments: Array<{ id: number; body: string; path: string; line: number | null }> = [];
    for (let page = 1; page <= 10; page++) {
      const batch = await this.request<typeof comments>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}/comments?per_page=100&page=${page}`);
      comments.push(...batch);
      if (batch.length < 100) break;
    }
    return comments;
  }

  async listPullRequestFiles(owner: string, repo: string, pullNumber: number): Promise<Array<{ filename: string; status: string; previous_filename?: string }>> {
    const files: Array<{ filename: string; status: string; previous_filename?: string }> = [];
    for (let page = 1; page <= 30; page++) {
      const batch = await this.request<typeof files>("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`);
      files.push(...batch);
      if (batch.length < 100) break;
    }
    return files;
  }

  /** Confirm-before-act (threat T01): re-read PR state from the API rather than trusting a webhook. */
  async getPullRequest(owner: string, repo: string, pullNumber: number): Promise<{ state: string; merged: boolean; merge_commit_sha: string | null; head: { sha: string } }> {
    return this.request("GET", `/repos/${owner}/${repo}/pulls/${pullNumber}`);
  }
}

export function suggestionBody(note: string, replacement: string, fingerprint?: string): string {
  const fence = replacement.includes("```") ? "````" : "```";
  const marker = fingerprint ? `\n<!-- docops:fp:${fingerprint} -->` : "";
  return `${note}\n\n${fence}suggestion\n${replacement}\n${fence}\n\n<sub>Suggested by DocOps (deterministic). Review before committing.</sub>${marker}`;
}

export function annotationsFromFindings(findings: readonly Finding[]): CheckRunAnnotation[] {
  return findings
    .filter((f) => f.file)
    .map((f) => ({
      path: f.file as string,
      start_line: f.line ?? 1,
      end_line: f.endLine ?? f.line ?? 1,
      annotation_level: f.severity === "error" ? "failure" : f.severity === "warning" ? "warning" : "notice",
      message: f.message.slice(0, 64_000),
      title: f.ruleId,
    }));
}

// ---------------------------------------------------------------------------- Actions runtime (no @actions/core dependency)

export function getInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

export function getBooleanInput(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = getInput(name, env).toLowerCase();
  if (value === "") return fallback;
  return ["true", "yes", "1", "on"].includes(value);
}

/** Write an output using the documented GITHUB_OUTPUT heredoc format. */
export function setOutput(name: string, value: string | number | boolean, env: NodeJS.ProcessEnv = process.env): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${String(value)}\n${delimiter}\n`);
}

export function appendStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Request a GitHub Actions OIDC token (needs `permissions: id-token: write`). */
export async function getActionsIdToken(audience: string, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) return null;
  const response = await fetchImpl(`${url}&audience=${encodeURIComponent(audience)}`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (!response.ok) throw new Error(`OIDC token request failed: HTTP ${response.status}`);
  const body = (await response.json()) as { value?: string };
  return body.value ?? null;
}

export interface PullRequestContext {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  baseRef: string;
  labels: string[];
  title: string;
  body: string;
  headRef: string;
}

/** Pull-request context from GITHUB_EVENT_PATH (pull_request / pull_request_target events). */
export function pullRequestFromEvent(event: unknown, repository: string | undefined): PullRequestContext | null {
  const pr = (event as { pull_request?: Record<string, unknown> } | null)?.pull_request;
  if (!pr || !repository) return null;
  const [owner = "", repo = ""] = repository.split("/");
  const base = pr.base as { ref?: string } | undefined;
  const head = pr.head as { sha?: string; ref?: string } | undefined;
  return {
    owner,
    repo,
    number: Number(pr.number),
    headSha: head?.sha ?? "",
    headRef: head?.ref ?? "",
    baseRef: base?.ref ?? "main",
    labels: ((pr.labels as Array<{ name?: string }> | undefined) ?? []).map((l) => l.name ?? "").filter(Boolean),
    title: String(pr.title ?? ""),
    body: String(pr.body ?? ""),
  };
}
