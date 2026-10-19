import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Role } from "@docops/core";
import { addTenantRoute, asPlatform, createApiToken, createPgliteClient, createTenant, ensureServiceAccount, migrate, withTenant } from "@docops/db";
import { FakeJiraClient, type JiraIssue } from "@docops/jira";
import { createApp } from "../src/app.ts";
import { grantServiceAccountRole } from "../src/auth.ts";
import { FsBlobStore, type AppDeps, type BlobStore } from "../src/context.ts";
import { BuildSigner, type CiTrustPolicy, type Jwk } from "../src/security.ts";

export const GITHUB_SECRET = "gh-webhook-secret";
export const JIRA_SECRET = "jira-webhook-secret";

export function jiraIssue(key: string, fields: Partial<JiraIssue["fields"]> = {}): JiraIssue {
  return {
    id: String(10000 + Number(key.split("-")[1])),
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { name: "Story" },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      fixVersions: [{ name: "2.4.0" }],
      updated: "2026-10-18T10:00:00.000Z",
      ...fields,
    },
  };
}

export interface TestEnv {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  tenantId: string;
  jira: FakeJiraClient;
  tokens: Record<"owner" | "ci" | "viewer" | "auditor" | "readonly", string>;
  request: (path: string, init?: RequestInit & { token?: string; json?: unknown }) => Promise<Response>;
  jwks: { keys: Jwk[] };
  trust: CiTrustPolicy[];
}

export async function createTestEnv(options: { maxBlobBytes?: number; blobs?: BlobStore } = {}): Promise<TestEnv> {
  const db = await createPgliteClient();
  await migrate(db);
  const tenant = await asPlatform(db, (tx) => createTenant(tx, { slug: "acme", name: "Acme" }));
  await asPlatform(db, (tx) => addTenantRoute(tx, "github_installation", "4242", tenant.id));

  const tokens = {} as TestEnv["tokens"];
  const make = async (name: keyof TestEnv["tokens"], role: Role | null, scopes: string[]) => {
    const sa = await withTenant(db, tenant.id, (tx) => ensureServiceAccount(tx, tenant.id, name));
    if (role) await grantServiceAccountRole(db, tenant.id, sa, role);
    tokens[name] = (await withTenant(db, tenant.id, (tx) => createApiToken(tx, { tenantId: tenant.id, principalType: "service_account", principalId: sa, name, scopes }))).secret;
  };
  await make("owner", "org_owner", ["admin"]);
  await make("ci", "ci_publisher", ["checks:write", "builds:write", "deployments:write", "links:write", "docs:read", "readiness:read"]);
  await make("viewer", "viewer", ["admin"]);
  await make("auditor", "auditor", ["audit:read", "docs:read"]);
  await make("readonly", "org_owner", ["docs:read"]);

  const jira = new FakeJiraClient("acme.atlassian.net", [
    jiraIssue("PAY-101"),
    jiraIssue("PAY-123"),
    jiraIssue("PAY-140"),
    jiraIssue("PAY-150", { issuetype: { name: "Task" } }),
  ]);
  const jwks = { keys: [] as Jwk[] };
  const trust: CiTrustPolicy[] = [];
  const deps: AppDeps = {
    db,
    blobs: options.blobs ?? new FsBlobStore(mkdtempSync(join(tmpdir(), "docops-blobs-"))),
    signer: new BuildSigner(),
    version: "test",
    jira: () => jira,
    jwks: async () => jwks,
    trustPolicies: async () => trust,
    config: {
      publicUrl: "http://docops.test",
      cell: "test",
      tokenSigningSecret: "test-signing-secret",
      previewSecret: "test-preview-secret",
      githubWebhookSecret: GITHUB_SECRET,
      jiraWebhookSecret: JIRA_SECRET,
      oidcAudience: "https://api.docops.example",
      maxBlobBytes: options.maxBlobBytes ?? 25 * 1024 * 1024,
    },
  };
  const app = createApp(deps);
  const request: TestEnv["request"] = (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set("authorization", `Bearer ${init.token}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    return Promise.resolve(app.request(path, { ...init, headers, body }));
  };
  return { app, deps, tenantId: tenant.id, jira, tokens, request, jwks, trust };
}
