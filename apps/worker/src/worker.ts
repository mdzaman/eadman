import { createHmac } from "node:crypto";
import { assertCheckableUrl } from "@docops/checks";
import type { CloudEvent } from "@docops/core";
import {
  activeDeployment,
  asPlatform,
  claimJobs,
  completeJob,
  createLink,
  enqueueJob,
  ensureTicketStub,
  event,
  failJob,
  getTicketByKey,
  markProcessed,
  reapExpiredJobs,
  relayOutbox,
  setTicketDocsStatus,
  ticketDocsView,
  upsertPullRequest,
  upsertRepository,
  upsertTicket,
  withTenant,
  writeOutbox,
  type JobRow,
  type Queryable,
  type SqlClient,
} from "@docops/db";
import type { GitHubClient } from "@docops/github";
import { linksFromPullRequest, pushDocsStatus, ticketFromIssue, type DocsRequiredPolicy, type JiraClient, type LinkSourceSetting } from "@docops/jira";

export const ALL_QUEUES = ["tracker.link", "tracker.mirror", "tracker.sync", "notify.webhooks", "content.index"] as const;

export interface WorkerDeps {
  db: SqlClient;
  workerId?: string;
  queues?: readonly string[];
  /** Jobs processed in parallel by this process (WORKER_CONCURRENCY). Default 4. */
  concurrency?: number;
  publicUrl: string;
  cell?: string;
  jira?: (tenantId: string) => JiraClient | null;
  github?: (tenantId: string, installationId: string | null) => GitHubClient | null;
  /** Per-tenant linking policy (docops.yaml integrations.jira in production). */
  linkPolicy?: (tenantId: string) => LinkPolicy;
  fetch?: typeof fetch;
  decryptSecret?: (ciphertext: Uint8Array) => string;
  log?: (entry: Record<string, unknown>) => void;
}

interface PullRequestEventData {
  repository: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  headRef: string;
  headSha: string;
  baseRef: string;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  url: string;
  labels: string[];
  updatedAt: string;
  installationId: string | null;
}

export interface LinkPolicy {
  linkFrom: LinkSourceSetting[];
  projects: string[];
  docsRequired: DocsRequiredPolicy;
  /** Forge read-only field key for "Docs status" (Jira Cloud). */
  statusFieldKey?: string;
}

const DEFAULT_POLICY: LinkPolicy = { linkFrom: ["pr_title", "pr_body", "branch_name", "commit_message"], projects: [], docsRequired: { issueTypes: ["Story", "Bug"] } };

export function signStandardWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

export class Worker {
  private readonly deps: WorkerDeps;
  private timer: NodeJS.Timeout | null = null;
  private readonly workerId: string;
  private readonly queues: readonly string[];
  private readonly concurrency: number;

  constructor(deps: WorkerDeps) {
    this.deps = deps;
    this.workerId = deps.workerId ?? `worker-${process.pid}`;
    this.queues = deps.queues ?? ALL_QUEUES;
    this.concurrency = Math.max(1, Math.floor(deps.concurrency ?? 4));
  }

  private log(entry: Record<string, unknown>): void {
    (this.deps.log ?? ((e) => console.log(JSON.stringify(e))))({ worker: this.workerId, ...entry });
  }

  /** One scheduling pass: relay the outbox, then drain ready jobs. Returns counts for observability and tests. */
  async runOnce(maxJobs = 100): Promise<{ relayed: number; processed: number; failed: number }> {
    const { db } = this.deps;
    const relayed = await asPlatform(db, (tx) => relayOutbox(tx));
    await asPlatform(db, (tx) => reapExpiredJobs(tx));
    let processed = 0;
    let failed = 0;
    while (processed + failed < maxJobs) {
      const limit = Math.min(this.concurrency, maxJobs - processed - failed);
      const jobs = await asPlatform(db, (tx) => claimJobs(tx, this.queues, this.workerId, limit));
      if (jobs.length === 0) {
        // Handlers may have written new outbox rows; relay them before stopping.
        if ((await asPlatform(db, (tx) => relayOutbox(tx))) === 0) break;
        continue;
      }
      // Handlers already tolerate parallel runs: other replicas claim jobs through SKIP LOCKED, and
      // tracker writes are last-write-wins on the source's updated_at.
      for (const ok of await Promise.all(jobs.map((job) => this.process(job)))) {
        if (ok) processed++;
        else failed++;
      }
    }
    return { relayed, processed, failed };
  }

  /** Run one claimed job and record its outcome (succeeded, or retry / dead-letter). */
  private async process(job: JobRow): Promise<boolean> {
    const { db } = this.deps;
    try {
      await this.handle(job);
      await asPlatform(db, (tx) => completeJob(tx, job.id));
      return true;
    } catch (error) {
      const outcome = await asPlatform(db, (tx) => failJob(tx, job, (error as Error).stack ?? String(error)));
      this.log({ level: outcome === "dead" ? "error" : "warn", msg: "job failed", queue: job.queue, jobId: job.id, outcome, error: (error as Error).message });
      return false;
    }
  }

  start(intervalMs = 1000): void {
    const tick = async () => {
      try {
        await this.runOnce();
      } catch (error) {
        this.log({ level: "error", msg: "tick failed", error: (error as Error).message });
      }
      this.timer = setTimeout(tick, intervalMs);
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async handle(job: JobRow): Promise<void> {
    const tenantId = job.tenant_id;
    if (!tenantId) return;
    const evt = (job.payload.event ?? null) as CloudEvent<Record<string, unknown>> | null;
    // Effectively-once: the (consumer, event id) ledger short-circuits redeliveries.
    if (evt && !(await asPlatform(this.deps.db, (tx) => markProcessed(tx, job.queue, evt.id)))) return;
    switch (job.queue) {
      case "tracker.link":
        return this.linkPullRequest(tenantId, evt?.data as unknown as PullRequestEventData);
      case "tracker.mirror":
        return this.mirrorIssue(tenantId, evt?.data as { key: string; issue?: unknown });
      case "tracker.sync":
        return this.syncFromEvent(tenantId, job, evt);
      case "notify.webhooks":
        return evt ? this.deliverWebhooks(tenantId, evt) : undefined;
      case "content.index":
        return; // Search/AI indexing lands in V1 (packages/ai chunker + SearchBackend).
      default:
        throw new Error(`no handler for queue ${job.queue}`);
    }
  }

  private policy(tenantId: string): LinkPolicy {
    return this.deps.linkPolicy?.(tenantId) ?? DEFAULT_POLICY;
  }

  private async ticketFor(tx: Queryable, tenantId: string, key: string) {
    const jira = this.deps.jira?.(tenantId);
    const existing = await getTicketByKey(tx, key);
    if (jira) {
      const issue = await jira.getIssue(key);
      if (issue) return upsertTicket(tx, tenantId, ticketFromIssue(issue, jira.site, this.policy(tenantId).docsRequired));
    }
    return existing ?? { id: await ensureTicketStub(tx, tenantId, key, jira?.site ?? "jira.local"), key };
  }

  /** PR → ticket links with provenance; PR files → doc pages; then recompute docs status. */
  private async linkPullRequest(tenantId: string, pr: PullRequestEventData): Promise<void> {
    if (!pr?.repository) return;
    const github = this.deps.github?.(tenantId, pr.installationId);
    const [owner = "", name = ""] = pr.repository.split("/");
    // Confirm before act (threat T01): re-read the PR state from the provider when we can.
    let state = pr.state;
    let files: Array<{ path: string; changeType: "added" | "modified" | "removed" | "renamed"; previousPath?: string | null }> = [];
    if (github) {
      const live = await github.getPullRequest(owner, name, pr.number);
      state = live.merged ? "merged" : live.state === "closed" ? "closed" : "open";
      files = (await github.listPullRequestFiles(owner, name, pr.number)).map((f) => ({
        path: f.filename,
        changeType: f.status === "added" ? "added" : f.status === "removed" ? "removed" : f.status === "renamed" ? "renamed" : "modified",
        previousPath: f.previous_filename ?? null,
      }));
    }
    const keys = linksFromPullRequest({ title: pr.title, body: pr.body, headRef: pr.headRef }, this.policy(tenantId).linkFrom, { projects: this.policy(tenantId).projects });
    const touched = await withTenant(this.deps.db, tenantId, async (tx) => {
      const repo = await upsertRepository(tx, tenantId, { provider: "github", fullName: pr.repository });
      const { rows: roots } = await tx.query<{ docs_root: string }>("SELECT docs_root FROM spaces WHERE repository_id = $1", [repo.id]);
      const docsRoots = roots.map((r) => `${r.docs_root.replace(/\/$/, "")}/`);
      const touchesDocs = files.some((f) => docsRoots.some((root) => f.path.startsWith(root)) && /\.mdx?$/.test(f.path));
      const prId = await upsertPullRequest(tx, tenantId, {
        repositoryId: repo.id,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        mergeCommitSha: pr.mergeCommitSha,
        mergedAt: pr.mergedAt,
        url: pr.url,
        touchesDocs,
        sourceUpdatedAt: pr.updatedAt,
        files,
      });
      // Map changed files to doc pages so merged PRs count as doc changes for their tickets.
      await tx.query(
        `UPDATE pull_request_files f SET page_id = p.id
         FROM pages p JOIN spaces s ON s.id = p.space_id
         WHERE f.pull_request_id = $1 AND f.path = s.docs_root || '/' || p.path`,
        [prId],
      );
      const affected = new Set<string>();
      for (const link of keys) {
        const ticket = await this.ticketFor(tx, tenantId, link.key);
        await createLink(tx, tenantId, { ticketId: ticket.id, targetType: "pull_request", targetId: prId, source: link.source, createdBy: "github-webhook" });
        affected.add(link.key);
      }
      // Tickets already linked to this PR are affected by state changes too.
      const { rows } = await tx.query<{ key: string }>("SELECT DISTINCT t.key FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE l.target_type = 'pull_request' AND l.target_id = $1", [prId]);
      rows.forEach((r) => affected.add(r.key));
      return [...affected];
    });
    for (const key of touched) await this.enqueueSync(tenantId, key);
    this.log({ level: "info", msg: "linked pull request", repository: pr.repository, number: pr.number, state, tickets: touched });
  }

  private async mirrorIssue(tenantId: string, data: { key: string }): Promise<void> {
    if (!data?.key) return;
    await withTenant(this.deps.db, tenantId, (tx) => this.ticketFor(tx, tenantId, data.key));
    await this.enqueueSync(tenantId, data.key);
  }

  private async enqueueSync(tenantId: string, key: string): Promise<void> {
    await asPlatform(this.deps.db, (tx) => enqueueJob(tx, { tenantId, queue: "tracker.sync", payload: { key }, coalesceKey: `${tenantId}:${key}`, priority: 50 }));
  }

  private async syncFromEvent(tenantId: string, job: JobRow, evt: CloudEvent<Record<string, unknown>> | null): Promise<void> {
    if (evt?.type === "docops.deployment.promoted") {
      const data = evt.data as { spaceId: string; environment: string };
      if (data.environment !== "prod") return;
      const keys = await withTenant(this.deps.db, tenantId, async (tx) =>
        (
          await tx.query<{ key: string }>(
            `SELECT DISTINCT t.key FROM tickets t JOIN ticket_links l ON l.ticket_id = t.id
             LEFT JOIN pages p ON l.target_type = 'page' AND p.id = l.target_id
             LEFT JOIN pull_request_files f ON l.target_type = 'pull_request' AND f.pull_request_id = l.target_id
             LEFT JOIN pages fp ON fp.id = f.page_id
             WHERE p.space_id = $1 OR fp.space_id = $1`,
            [data.spaceId],
          )
        ).rows.map((r) => r.key),
      );
      for (const key of keys) await this.enqueueSync(tenantId, key);
      return;
    }
    const key = (job.payload.key as string | undefined) ?? (evt?.data?.ticketKey as string | undefined) ?? (evt?.data?.key as string | undefined);
    if (key) await this.syncTicket(tenantId, key);
  }

  /** Recompute docs status, emit a change event, and write the truth back into Jira. */
  async syncTicket(tenantId: string, key: string): Promise<void> {
    const jira = this.deps.jira?.(tenantId) ?? null;
    const result = await withTenant(this.deps.db, tenantId, async (tx) => {
      const ticket = await getTicketByKey(tx, key);
      if (!ticket) return null;
      const view = await ticketDocsView(tx, ticket);
      const previous = await setTicketDocsStatus(tx, ticket.id, view.status);
      if (previous !== view.status) {
        await writeOutbox(tx, event(tenantId, "docops.ticket.docs_status_changed", { ticketKey: key, previous, current: view.status, reasons: view.reasons }, `tickets/${key}`), `${tenantId}:${key}`);
      }
      const tenant = (await tx.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = $1", [tenantId])).rows[0];
      const pages = [];
      for (const page of view.pages) {
        const prod = await activeDeployment(tx, page.spaceKey, "prod");
        const slug = page.path.replace(/\.(md|mdx)$/, "").replace(/(^|\/)index$/, "");
        pages.push({ ...page, url: prod ? `${this.deps.publicUrl}/sites/${tenant?.slug}/${page.spaceKey}/prod/${slug ? `${slug}/` : ""}` : null });
      }
      return { ticket, view, pages };
    });
    if (!result || !jira) return;
    await pushDocsStatus(
      jira,
      { key, id: result.ticket.external_id },
      {
        required: result.ticket.docs_required,
        status: result.view.status,
        reasons: result.view.reasons,
        pages: result.pages.map((p) => ({ path: p.path, title: p.title, url: p.url, stale: p.stale, pageId: p.pageId })),
        pullRequests: result.view.pullRequests.map((p) => ({ repo: p.repository, number: p.number, state: p.state, url: p.url, title: p.title })),
      },
      { tenantId, source: `docops://cells/${this.deps.cell ?? "local"}`, statusFieldKey: this.policy(tenantId).statusFieldKey },
    );
  }

  /** Standard Webhooks delivery to subscribed endpoints (SSRF-guarded, signed, at-least-once). */
  private async deliverWebhooks(tenantId: string, evt: CloudEvent): Promise<void> {
    const subs = await withTenant(this.deps.db, tenantId, async (tx) =>
      (await tx.query<{ id: string; url: string; secret_ciphertext: Uint8Array }>("SELECT id, url, secret_ciphertext FROM webhook_subscriptions WHERE active AND $1 = ANY(event_types)", [evt.type])).rows,
    );
    const body = JSON.stringify(evt);
    const timestamp = Math.floor(Date.now() / 1000);
    for (const sub of subs) {
      assertCheckableUrl(sub.url);
      const secret = (this.deps.decryptSecret ?? ((b) => Buffer.from(b).toString()))(sub.secret_ciphertext);
      const response = await (this.deps.fetch ?? fetch)(sub.url, {
        method: "POST",
        headers: {
          "content-type": "application/cloudevents+json",
          "webhook-id": evt.id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signStandardWebhook(secret, evt.id, timestamp, body),
        },
        body,
        redirect: "manual",
      });
      await withTenant(this.deps.db, tenantId, (tx) =>
        tx.query("UPDATE webhook_subscriptions SET last_delivery_at = now(), failure_count = CASE WHEN $2 THEN 0 ELSE failure_count + 1 END WHERE id = $1", [sub.id, response.ok]),
      );
      if (!response.ok) throw new Error(`webhook ${sub.url} answered ${response.status}`);
    }
  }
}
