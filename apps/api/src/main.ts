import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { DOCOPS_VERSION } from "@docops/core";
import {
  addTenantRoute,
  asPlatform,
  createApiToken,
  createPgliteClient,
  createPostgresClient,
  createTenant,
  ensureServiceAccount,
  getTenantBySlug,
  lookupApiToken,
  migrate,
  withTenant,
  type SqlClient,
} from "@docops/db";
import { HttpJiraClient } from "@docops/jira";
import { Worker } from "@docops/worker";
import { createApp } from "./app.ts";
import { grantServiceAccountRole } from "./auth.ts";
import { FsBlobStore, type AppDeps, type BlobStore } from "./context.ts";
import { S3BlobStore, s3OptionsFromEnv } from "./s3.ts";
import { BuildSigner, type CiTrustPolicy } from "./security.ts";

function secret(name: string): string {
  const value = process.env[name];
  if (value) return value;
  console.warn(`[docops-api] ${name} not set; using an ephemeral random value (tokens and preview links will not survive a restart)`);
  return randomBytes(32).toString("base64url");
}

/** Create the tenant, service account, org_owner binding and token named by DOCOPS_BOOTSTRAP_TOKEN (dev/self-hosted first run). */
async function bootstrap(db: SqlClient): Promise<void> {
  const token = process.env.DOCOPS_BOOTSTRAP_TOKEN;
  if (!token) return;
  if (!/^dop_[A-Za-z0-9]{20,}$/.test(token)) {
    console.error("[docops-api] DOCOPS_BOOTSTRAP_TOKEN must look like dop_ followed by at least 20 letters or digits");
    return;
  }
  if (await asPlatform(db, (tx) => lookupApiToken(tx, token))) return;
  const slug = process.env.DOCOPS_BOOTSTRAP_TENANT ?? "acme";
  const tenant = (await asPlatform(db, (tx) => getTenantBySlug(tx, slug))) ?? (await asPlatform(db, (tx) => createTenant(tx, { slug, name: slug })));
  const sa = await withTenant(db, tenant.id, (tx) => ensureServiceAccount(tx, tenant.id, "bootstrap"));
  await grantServiceAccountRole(db, tenant.id, sa, "org_owner");
  await withTenant(db, tenant.id, (tx) => createApiToken(tx, { tenantId: tenant.id, principalType: "service_account", principalId: sa, name: "bootstrap", scopes: ["admin"], secret: token }));
  const installation = process.env.DOCOPS_BOOTSTRAP_GITHUB_INSTALLATION;
  if (installation) await asPlatform(db, (tx) => addTenantRoute(tx, "github_installation", installation, tenant.id));
  console.log(`[docops-api] bootstrapped tenant "${slug}" with an admin token`);
}

/** An S3-compatible bucket when DOCOPS_S3_BUCKET is set (any number of replicas), else the filesystem under DOCOPS_BLOB_DIR. */
function blobStoreFromEnv(dataDir: string): BlobStore {
  if (process.env.DOCOPS_S3_BUCKET) {
    const store = new S3BlobStore(s3OptionsFromEnv(process.env));
    console.log(`[docops-api] storing blobs in S3 bucket "${store.bucket}" at ${store.endpoint.origin} (${store.pathStyle ? "path-style" : "virtual-hosted"} URLs)`);
    return store;
  }
  const blobDir = process.env.DOCOPS_BLOB_DIR ?? join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true });
  return new FsBlobStore(blobDir);
}

export async function createDepsFromEnv(): Promise<AppDeps> {
  const dataDir = process.env.DOCOPS_DATA_DIR ?? ".docops/data";
  const blobs = blobStoreFromEnv(dataDir);
  if (!process.env.DATABASE_URL) mkdirSync(join(dataDir, "pglite"), { recursive: true });
  const db = process.env.DATABASE_URL ? createPostgresClient(process.env.DATABASE_URL) : await createPgliteClient(join(dataDir, "pglite"));
  await migrate(db);
  await bootstrap(db);
  const jira =
    process.env.JIRA_BASE_URL && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN
      ? new HttpJiraClient({ baseUrl: process.env.JIRA_BASE_URL, auth: { type: "basic", email: process.env.JIRA_EMAIL, apiToken: process.env.JIRA_API_TOKEN } })
      : null;
  const trust: CiTrustPolicy[] = process.env.DOCOPS_CI_TRUST_POLICIES ? (JSON.parse(process.env.DOCOPS_CI_TRUST_POLICIES) as CiTrustPolicy[]) : [];
  if (!process.env.DOCOPS_SIGNING_KEY_PEM) {
    console.warn(
      "[docops-api] DOCOPS_SIGNING_KEY_PEM not set; using an ephemeral Ed25519 key. Builds finalized by this process cannot be promoted by another replica or after a restart (generate one with: openssl genpkey -algorithm ed25519)",
    );
  }
  return {
    db,
    blobs,
    signer: new BuildSigner(process.env.DOCOPS_SIGNING_KEY_PEM),
    version: DOCOPS_VERSION,
    jira: () => jira,
    trustPolicies: async () => trust,
    config: {
      publicUrl: (process.env.DOCOPS_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8787}`).replace(/\/$/, ""),
      cell: process.env.DOCOPS_CELL ?? "local",
      tokenSigningSecret: secret("DOCOPS_TOKEN_SIGNING_SECRET"),
      previewSecret: secret("DOCOPS_PREVIEW_SECRET"),
      githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
      jiraWebhookSecret: process.env.JIRA_WEBHOOK_SECRET,
      oidcAudience: process.env.DOCOPS_OIDC_AUDIENCE ?? "https://api.docops.example",
      forgeAppId: process.env.DOCOPS_FORGE_APP_ID,
      maxBlobBytes: 25 * 1024 * 1024,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = await createDepsFromEnv();
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: createApp(deps).fetch, port }, (info) => console.log(`[docops-api] listening on http://localhost:${info.port} (cell ${deps.config.cell})`));
  if (deps.db.kind === "pglite") {
    // Embedded PGlite allows one process per data directory, so a separate worker cannot open it:
    // run the queue consumers in this process instead (modular monolith, ADR-0002).
    new Worker({ db: deps.db, publicUrl: deps.config.publicUrl, cell: deps.config.cell, jira: deps.jira }).start(Number(process.env.WORKER_POLL_MS ?? 1000));
    console.log("[docops-api] embedded database: the worker runs in this process");
  }
}
