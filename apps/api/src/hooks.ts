import { badRequest, DocOpsError, forbidden, PORTAL_SECURITY_HEADERS, sha256Hex, unauthorized } from "@docops/core";
import {
  activeDeployment,
  appendAudit,
  asPlatform,
  buildFile,
  event,
  getTenantBySlug,
  recordDelivery,
  resolveTenantRoute,
  withTenant,
  writeOutbox,
} from "@docops/db";
import { verifyGithubSignature } from "@docops/github";
import { verifyJiraSignature } from "@docops/jira";
import type { Ctx } from "./context.ts";
import type { RouteDef } from "./routes.ts";
import { evaluateTrustPolicies, fetchJwks, issueAccessToken, verifyOidcToken, verifyPreviewToken } from "./security.ts";
import { authenticateForgeInvocation, ensureCiServiceAccount } from "./auth.ts";

/** Normalized PR payload carried on `docops.git.pull_request.*` events (references only, no file contents). */
export interface PullRequestEventData {
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

export const hookRoutes: RouteDef[] = [
  {
    method: "GET",
    path: "/healthz",
    operationId: "getHealth",
    auth: "none",
    handler: async (c) => {
      let database: "ok" | "failing" = "ok";
      try {
        await c.get("deps").db.query("SELECT 1");
      } catch {
        database = "failing";
      }
      return c.json({ status: database === "ok" ? "ok" : "degraded", version: c.get("deps").version, checks: { database } }, database === "ok" ? 200 : 503);
    },
  },
  {
    method: "POST",
    path: "/v1/auth/oidc-exchange",
    operationId: "exchangeOidcToken",
    auth: "none",
    handler: async (c) => {
      const deps = c.get("deps");
      const form = new URLSearchParams(await c.req.text());
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" || form.get("subject_token_type") !== "urn:ietf:params:oauth:token-type:jwt") {
        throw badRequest("grant_type and subject_token_type must be RFC 8693 token exchange values");
      }
      const subjectToken = form.get("subject_token") ?? "";
      const tenantSlug = c.req.query("tenant") ?? form.get("tenant") ?? "";
      const tenant = await asPlatform(deps.db, (tx) => getTenantBySlug(tx, tenantSlug));
      if (!tenant || !deps.trustPolicies) throw forbidden("No CI trust policy for this tenant");
      const policies = await deps.trustPolicies(tenant.slug);
      let issuer = "";
      try {
        issuer = String(JSON.parse(Buffer.from(subjectToken.split(".")[1] ?? "", "base64url").toString()).iss ?? "");
      } catch {
        throw badRequest("subject_token is not a JWT");
      }
      const policy = policies.find((p) => p.issuer === issuer);
      if (!policy) throw forbidden("Issuer is not trusted by this tenant");
      let claims: Record<string, unknown>;
      try {
        claims = (await verifyOidcToken(subjectToken, { issuer, audience: policy.audience, jwks: deps.jwks ?? fetchJwks })).claims;
      } catch (error) {
        throw forbidden(`OIDC token rejected: ${(error as Error).message}`);
      }
      const grant = evaluateTrustPolicies(policies, issuer, claims);
      if (!grant) throw forbidden("No trust-policy rule matches this workload");
      const requested = (form.get("scope") ?? "").split(" ").filter(Boolean);
      const scopes = requested.length > 0 ? requested.filter((s) => grant.scopes.includes(s)) : grant.scopes;
      const serviceAccountId = await ensureCiServiceAccount(deps.db, tenant.id, `ci:${grant.repository ?? policy.provider}`);
      const accessToken = issueAccessToken(deps.config.tokenSigningSecret, { sub: serviceAccountId, tid: tenant.id, scp: scopes, repo: grant.repository, env: grant.environments.join(",") || undefined });
      await withTenant(deps.db, tenant.id, async (tx) => {
        await appendAudit(tx, tenant.id, {
          actor: { type: "service_account", id: `service_account:${serviceAccountId}`, authMethod: "ci_oidc" },
          action: "auth.token_exchanged",
          resource: { type: "service_account", id: serviceAccountId },
          outcome: "success",
          details: { issuer, repository: grant.repository, scopes, ref: claims.ref ?? null },
        });
      });
      return c.json({ access_token: accessToken, token_type: "Bearer", expires_in: 900, scope: scopes.join(" "), issued_token_type: "urn:ietf:params:oauth:token-type:access_token" });
    },
  },
  {
    method: "POST",
    path: "/hooks/github",
    operationId: "receiveGithubWebhook",
    auth: "none",
    handler: async (c) => {
      const deps = c.get("deps");
      const raw = await c.req.text();
      const deliveryId = c.req.header("x-github-delivery") ?? "";
      const eventType = c.req.header("x-github-event") ?? "";
      const digest = sha256Hex(raw);
      const valid = verifyGithubSignature(deps.config.githubWebhookSecret ?? "", raw, c.req.header("x-hub-signature-256"));
      if (!valid || !deliveryId || !eventType) {
        if (deliveryId) await asPlatform(deps.db, (tx) => recordDelivery(tx, { provider: "github", deliveryId, eventType: eventType || "unknown", tenantId: null, signatureValid: false, status: "rejected", payloadDigest: digest, error: "invalid signature" }));
        throw unauthorized("Invalid webhook signature");
      }
      const payload = JSON.parse(raw) as Record<string, any>;
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;
      const outcome = await asPlatform(deps.db, async (tx) => {
        const tenantId = installationId ? await resolveTenantRoute(tx, "github_installation", installationId) : null;
        const status = await recordDelivery(tx, { provider: "github", deliveryId, eventType, tenantId, signatureValid: true, status: "accepted", payloadDigest: digest });
        return { tenantId, status };
      });
      if (outcome.status === "duplicate" || !outcome.tenantId) return c.json({ status: outcome.status === "duplicate" ? "duplicate" : "ignored" }, 202);

      if (eventType === "pull_request" && payload.pull_request) {
        const pr = payload.pull_request;
        const data: PullRequestEventData = {
          repository: String(payload.repository?.full_name ?? ""),
          number: Number(pr.number),
          title: String(pr.title ?? ""),
          body: String(pr.body ?? ""),
          state: pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open",
          headRef: String(pr.head?.ref ?? ""),
          headSha: String(pr.head?.sha ?? ""),
          baseRef: String(pr.base?.ref ?? ""),
          mergeCommitSha: pr.merge_commit_sha ?? null,
          mergedAt: pr.merged_at ?? null,
          url: String(pr.html_url ?? ""),
          labels: (pr.labels ?? []).map((l: { name?: string }) => l.name ?? ""),
          updatedAt: String(pr.updated_at ?? new Date().toISOString()),
          installationId,
        };
        await withTenant(deps.db, outcome.tenantId, (tx) =>
          writeOutbox(tx, { ...event(outcome.tenantId!, `docops.git.pull_request.${String(payload.action ?? "updated")}`, data, `${data.repository}/pulls/${data.number}`), id: deliveryId }, `${outcome.tenantId}:${data.repository}:${data.number}`),
        );
      } else if (eventType === "push") {
        await withTenant(deps.db, outcome.tenantId, (tx) =>
          writeOutbox(tx, { ...event(outcome.tenantId!, "docops.git.push", { repository: payload.repository?.full_name, ref: payload.ref, after: payload.after }), id: deliveryId }, `${outcome.tenantId}:${payload.repository?.full_name}:${payload.ref}`),
        );
      }
      return c.json({ status: "accepted" }, 202);
    },
  },
  {
    method: "POST",
    path: "/hooks/jira",
    operationId: "receiveJiraWebhook",
    auth: "none",
    handler: async (c) => {
      const deps = c.get("deps");
      const raw = await c.req.text();
      const fit = /^Bearer\s+(\S+)$/i.exec(c.req.header("authorization") ?? "")?.[1];
      let tenantId: string;
      let deliveryId: string;
      if (fit) {
        // Forge Remote trigger (manifest endpoint docops-events): the FIT alone authenticates the call, its
        // installation names the tenant (docs/06 §3) and its jti is the delivery ID (docs/04 §5).
        const forge = await authenticateForgeInvocation(deps, fit);
        tenantId = forge.tenantId;
        deliveryId = forge.invocation.tokenId;
      } else {
        // Data Center / admin webhooks: HMAC + tenant in the URL.
        const valid = verifyJiraSignature(deps.config.jiraWebhookSecret ?? "", raw, c.req.header("x-hub-signature"));
        const tenant = valid ? await asPlatform(deps.db, (tx) => getTenantBySlug(tx, c.req.query("tenant") ?? "")) : null;
        if (!valid || !tenant) throw unauthorized("Invalid webhook signature or tenant");
        tenantId = tenant.id;
        deliveryId = c.req.header("x-atlassian-webhook-identifier") ?? sha256Hex(raw).slice(0, 32);
      }
      const payload = JSON.parse(raw) as Record<string, any>;
      const status = await asPlatform(deps.db, (tx) =>
        recordDelivery(tx, { provider: "jira", deliveryId, eventType: String(payload.webhookEvent ?? payload.eventType ?? "unknown"), tenantId, signatureValid: true, status: "accepted", payloadDigest: sha256Hex(raw) }),
      );
      if (status === "duplicate") return c.json({ status: "duplicate" }, 202);
      const issue = payload.issue as { key?: string; id?: string } | undefined;
      if (issue?.key) {
        await withTenant(deps.db, tenantId, (tx) =>
          writeOutbox(tx, { ...event(tenantId, "docops.tracker.issue_updated", { key: issue.key, id: issue.id, webhookEvent: payload.webhookEvent ?? payload.eventType, issue: payload.issue }), id: deliveryId }, `${tenantId}:${issue.key}`),
        );
      }
      return c.json({ status: "accepted" }, 202);
    },
  },
  {
    method: "GET",
    path: "/sites/{tenant}/{space}/{environment}/{path}",
    operationId: "serveSite",
    auth: "none",
    handler: (c) => serveSite(c),
  },
];

/** Serve a file of the active deployment (the CDN does this in production; same lookup semantics). */
export async function serveSite(c: Ctx): Promise<Response> {
  const deps = c.get("deps");
  const parts = c.req.path.split("/").slice(2); // ["acme", "payments", "prod", ...rest]
  const [tenantSlug = "", spaceKey = "", environment = "", ...rest] = parts.map((p) => decodeURIComponent(p));
  if (rest.some((p) => p === ".." || p.includes("\0"))) throw badRequest("invalid path");
  let path = rest.join("/");
  if (path === "" || path.endsWith("/")) path = `${path}index.html`;
  const tenant = await asPlatform(deps.db, (tx) => getTenantBySlug(tx, tenantSlug));
  if (!tenant) throw new DocOpsError("not_found", "Not found", 404);
  if (environment.startsWith("preview-")) {
    const token = c.req.query("pt") ?? (c.req.header("cookie") ?? "").match(/(?:^|;\s*)docops_pt=([^;]+)/)?.[1];
    if (!verifyPreviewToken(deps.config.previewSecret, `${tenantSlug}/${spaceKey}/${environment}`, token ? decodeURIComponent(token) : undefined)) {
      throw forbidden("Preview links require a valid preview token");
    }
  }
  const file = await withTenant(deps.db, tenant.id, async (tx) => {
    const deployment = await activeDeployment(tx, spaceKey, environment);
    if (!deployment) return null;
    return (await buildFile(tx, deployment.build_id, path)) ?? (path.endsWith("index.html") ? null : await buildFile(tx, deployment.build_id, `${path}/index.html`));
  });
  if (!file) throw new DocOpsError("not_found", "Not found", 404);
  const bytes = await deps.blobs.get(tenant.id, file.digest);
  if (!bytes) throw new DocOpsError("not_found", "Not found", 404);
  const headers: Record<string, string> = {
    ...PORTAL_SECURITY_HEADERS,
    "content-type": file.content_type,
    etag: `"${file.digest}"`,
    "cache-control": environment.startsWith("preview-") ? "private, no-store" : file.content_type.startsWith("text/html") ? "public, max-age=60" : "public, max-age=3600",
  };
  if (environment.startsWith("preview-")) {
    headers["x-robots-tag"] = "noindex, nofollow";
    const pt = c.req.query("pt");
    if (pt) headers["set-cookie"] = `docops_pt=${encodeURIComponent(pt)}; Path=/sites/${tenantSlug}/${spaceKey}/${environment}/; HttpOnly; Secure; SameSite=Lax`;
  }
  if (c.req.header("if-none-match") === headers.etag) return c.body(null, 304, headers);
  return c.body(new Uint8Array(bytes), 200, headers);
}
