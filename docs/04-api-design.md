---
title: API Design
owners: ["@docops/api"]
reviewed: 2026-10-18
status: proposed
---

# EADMan: API Design

The canonical contract is [`api/openapi.yaml`](../api/openapi.yaml) (OpenAPI 3.1, linted with Redocly's recommended ruleset). This document explains the design rules, lists every operation, and catalogs the outbound webhook events, which are defined in the same file under the OpenAPI 3.1 `webhooks` object.

> **Dogfooding.** This repository's `docops.yaml` declares `api/openapi.yaml` as a reference source, so `docops check` fails CI if an operation in the spec is not documented here (`coverage/undocumented-entity`). The operation catalog in §3 is what satisfies that gate.

## 1. Design rules

| Concern | Rule |
|---|---|
| Style | Resource-oriented REST under `/v1`. Actions that aren't CRUD are sub-resources (`POST /v1/suggestions/{suggestionId}/accept`). JSON field names are camelCase. |
| Tenancy | The tenant comes from the credential and never appears in a URL. Requests for another tenant's resource return `404`, not `403`, to avoid confirming that it exists. |
| Identifiers | UUIDv7 strings. Natural keys are accepted where users think in them (`/v1/tickets/{ticketKey}/docs`). |
| Pagination | Cursor based: `?cursor=&limit=` (1–200, default 50), with `nextCursor: null` on the last page. Cursors are opaque and encode a key position, not an offset, so pages stay stable under concurrent writes. |
| Idempotency | Every state-creating `POST` accepts `Idempotency-Key`. A replay within 24 h returns the stored response; a replay with a different body returns `409`. |
| Concurrency | Mutable resources return an `ETag`; updates accept `If-Match`, and a mismatch returns `412`. |
| Errors | RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, plus `code`, `traceId` and JSON-pointer `errors[]` for validation failures. |
| Rate limits | Per token and per tenant. Responses carry the IETF `RateLimit-Policy` / `RateLimit` headers; `429` includes `Retry-After`. CI tokens get burst allowances sized for monorepo fan-out. |
| Versioning | The major version is in the path. Within `/v1` changes are additive only (new fields, operations and enum values; clients must ignore unknown fields). Deprecations announce `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) headers at least 12 months ahead. |
| Async work | Long operations return `202` with a resource to poll, and emit a webhook when they finish. |
| Observability | `traceparent` is accepted and returned. Every response includes `X-Request-Id`. |
| Size limits | JSON bodies ≤ 10 MiB (check runs are capped at 5,000 findings), blobs ≤ 25 MiB, and up to 100k manifest entries per build. |

## 2. Authentication and authorization

| Caller | Mechanism | Notes |
|---|---|---|
| Humans (web app, IDE) | OIDC or SAML SSO establishes a session; the browser holds an HttpOnly cookie and API calls use a short-lived access JWT | MFA is enforced by the IdP |
| CI pipelines | **Workload identity federation.** `POST /v1/auth/oidc-exchange` (RFC 8693) swaps the CI provider's OIDC token for a 15-minute EADMan token | Trust policies pin immutable claims: GitHub `repository_id` and `repository_owner_id` (immutable `sub` claims are rolling out for new repositories), plus `ref` and `environment`. No long-lived secrets live in CI. |
| Scripts and integrations | API tokens `dop_…` (SHA-256 hashed at rest, shown once, prefix kept for identification, expiry ≤ 365 days) | Scoped; can be bound to a service account |
| Jira Forge app | Forge Remote sends a **Forge Invocation Token** (FIT) as `Authorization: Bearer` | Verified against Atlassian's JWKS with `iss = forge/invocation-token` and `aud =` the app ARI; `app.installationId` maps to the tenant through `tenant_routes` |
| Git provider webhooks | HMAC: GitHub `X-Hub-Signature-256`, Jira `X-Hub-Signature`, GitLab `X-Gitlab-Token` | Constant-time compare; deliveries deduplicated by delivery ID |

**Scopes:** `docs:read`, `docs:write`, `checks:write`, `builds:write`, `deployments:write`, `links:write`, `readiness:read`, `ai:use`, `audit:read`, `admin`. Scopes cap what a token *may* do. Role bindings decide what the principal *can* do on each resource, and the effective permission is the intersection of the two ([RBAC matrix](08-security-compliance.md#3-rbac-matrix)).

**Example CI trust policy** (configured per tenant):

```yaml
# Admin → Integrations → CI trust policies
- provider: github-actions
  issuer: https://token.actions.githubusercontent.com
  audience: https://api.docops.example
  claims:
    repository_owner_id: "8429187"      # immutable; survives org renames
    repository_id: "702145778"          # immutable; prevents repo-name resurrection attacks
  rules:
    - match: { ref: "refs/heads/main" }
      grant: [checks:write, builds:write, deployments:write]
      environments: [dev]
    - match: { event_name: pull_request }
      grant: [checks:write, builds:write]   # previews only
    - match: { environment: production }
      grant: [deployments:write]
      environments: [prod]
```

## 3. Operation catalog

Generated from the spec: 63 operations, 47 of them in the MVP. The scaffold in `apps/api` implements the MVP flows listed in [MVP scaffold §3](10-mvp-scaffold.md#3-what-is-implemented), and `apps/api/test/contract.test.ts` asserts that every implemented route is declared in the spec.

**Operations**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /healthz` | `getHealth` | MVP | Liveness and readiness |

**Identity**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/me` | `getMe` | MVP | Current principal, tenant and effective scopes |
| `POST /v1/auth/oidc-exchange` | `exchangeOidcToken` | MVP | Exchange a CI OIDC token for a short-lived EADMan token (RFC 8693) |
| `GET /v1/api-tokens` | `listApiTokens` | MVP | List API tokens (metadata only) |
| `POST /v1/api-tokens` | `createApiToken` | MVP | Create an API token (secret returned once) |
| `DELETE /v1/api-tokens/{tokenId}` | `revokeApiToken` | MVP | Revoke an API token |
| `GET /v1/role-bindings` | `listRoleBindings` | MVP | List role bindings |
| `POST /v1/role-bindings` | `createRoleBinding` | MVP | Grant a role to a principal at a scope |
| `DELETE /v1/role-bindings/{bindingId}` | `deleteRoleBinding` | MVP | Remove a role binding |

**Repositories**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/repositories` | `listRepositories` | MVP | List connected repositories |
| `POST /v1/repositories` | `connectRepository` | MVP | Connect a repository |
| `GET /v1/repositories/{repositoryId}` | `getRepository` | MVP | Get a repository |
| `POST /v1/snapshots` | `uploadSnapshot` | MVP | Upload an extracted content snapshot for a commit (from `docops check`/`docops extract`) |
| `GET /v1/repositories/{repositoryId}/snapshots/{commitSha}` | `getSnapshot` | MVP | Get the entity snapshot recorded for a commit (used as the PR base) |

**Content**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/spaces` | `listSpaces` | MVP | List documentation spaces |
| `GET /v1/spaces/{spaceId}` | `getSpace` | MVP | Get a space |
| `GET /v1/spaces/{spaceId}/versions` | `listVersions` | MVP | List versions of a space |
| `GET /v1/spaces/{spaceId}/pages` | `listPages` | MVP | List pages in a space |
| `GET /v1/pages/{pageId}` | `getPage` | MVP | Get a page with its current revision metadata |
| `GET /v1/pages/{pageId}/graph` | `getPageGraph` | MVP | Graph neighborhood of a page (entities, tickets, owners, staleness) |
| `GET /v1/spaces/{spaceId}/coverage` | `getCoverage` | MVP | Documentation coverage of public entities |
| `GET /v1/spaces/{spaceId}/freshness` | `getFreshness` | V1 | Pages overdue for review or stale against changed entities |

**Entities**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/entities` | `listEntities` | MVP | List or search entities |
| `GET /v1/entities/{entityId}` | `getEntity` | MVP | Get an entity with the pages that reference it |
| `GET /v1/entities/{entityId}/history` | `getEntityHistory` | V1 | Definition history (one entry per fingerprint change) |

**Checks**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `POST /v1/check-runs` | `createCheckRun` | MVP | Record a quality-gate run (uploaded by the CLI) |
| `GET /v1/check-runs/{checkRunId}` | `getCheckRun` | MVP | Get a check run with its findings |
| `GET /v1/findings` | `listFindings` | MVP | List findings across check runs |
| `POST /v1/findings/{findingId}/dismiss` | `dismissFinding` | MVP | Dismiss a finding (persists across runs by fingerprint; audited) |

**Builds**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `POST /v1/builds` | `createBuild` | MVP | Start a build upload; returns the digests the server does not have yet |
| `PUT /v1/blobs/{digest}` | `uploadBlob` | MVP | Upload a content-addressed blob (sha256 verified server-side) |
| `GET /v1/builds/{buildId}` | `getBuild` | MVP | Get a build |
| `POST /v1/builds/{buildId}/finalize` | `finalizeBuild` | MVP | Verify all blobs are present, sign the manifest and mark the build ready |
| `GET /v1/deployments` | `listDeployments` | MVP | List deployments |
| `POST /v1/deployments` | `createDeployment` | MVP | Promote an immutable build to an environment (atomic alias switch) |

**Tracker**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/tickets/{ticketKey}/docs` | `getTicketDocs` | MVP | Docs status of a ticket (powers the Jira issue panel) |
| `GET /v1/links` | `listLinks` | MVP | List ticket links |
| `POST /v1/links` | `createLink` | MVP | Link a ticket to a page, PR, release or entity |
| `DELETE /v1/links/{linkId}` | `deleteLink` | MVP | Remove a manual link (derived links are removed by changing the source) |
| `GET /v1/readiness` | `getReadiness` | MVP | Release readiness for a tracker fix version |
| `POST /v1/readiness/doc-tasks` | `createDocTasks` | MVP | Create doc sub-tasks for tickets whose docs are missing |
| `GET /v1/traceability` | `getTraceability` | V1 | Requirement → ticket → commit → PR → page → release chain |
| `POST /v1/traceability/exports` | `createTraceabilityExport` | V2 | Export a signed traceability evidence bundle (in-toto attestation) |
| `GET /v1/releases` | `listReleases` | V1 | List releases (Git tags and tracker versions) |
| `POST /v1/releases/{releaseId}/notes` | `generateReleaseNotes` | V1 | Generate release notes as a pull request (AI polish optional, never auto-merged) |

**AI**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/search` | `search` | V1 | Hybrid search (permission-filtered) |
| `POST /v1/ask` | `ask` | V1 | Ask-the-docs (grounded, cited, permission-filtered) |
| `GET /v1/suggestions` | `listSuggestions` | MVP | List AI suggestions awaiting or past human decision |
| `GET /v1/suggestions/{suggestionId}` | `getSuggestion` | MVP | Get an AI suggestion with full provenance |
| `POST /v1/suggestions/{suggestionId}/accept` | `acceptSuggestion` | MVP | Accept (optionally edited); commits to the PR branch as the accepting human |
| `POST /v1/suggestions/{suggestionId}/reject` | `rejectSuggestion` | MVP | Reject a suggestion (feeds precision metrics) |
| `POST /v1/feedback` | `submitFeedback` | V1 | Reader feedback on a page or an answer |

**Governance**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /v1/audit-events` | `listAuditEvents` | MVP | Query the hash-chained audit log (auditor role) |
| `POST /v1/exports` | `createExport` | V1 | Full tenant metadata export (JSONL with schemas); content is already in Git |
| `GET /v1/exports/{exportId}` | `getExport` | V1 | Export status and download URL |
| `GET /v1/webhook-subscriptions` | `listWebhookSubscriptions` | V1 | List outbound webhook subscriptions |
| `POST /v1/webhook-subscriptions` | `createWebhookSubscription` | V1 | Subscribe an HTTPS endpoint to events (signing secret returned once) |
| `DELETE /v1/webhook-subscriptions/{subscriptionId}` | `deleteWebhookSubscription` | V1 | Delete a subscription |
| `POST /v1/webhook-subscriptions/{subscriptionId}/test` | `testWebhookSubscription` | V1 | Send a signed `docops.ping` event |

**Inbound webhooks**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `POST /hooks/github` | `receiveGithubWebhook` | MVP | GitHub App webhook receiver |
| `POST /hooks/jira` | `receiveJiraWebhook` | MVP | Jira webhook receiver (Forge Remote events with FIT, or Data Center webhooks with HMAC) |
| `POST /hooks/gitlab` | `receiveGitlabWebhook` | V1 | GitLab webhook receiver (`X-Gitlab-Token` / signing token) |

**Serving**

| Operation | operationId | Phase | Summary |
|---|---|---|---|
| `GET /sites/{tenant}/{space}/{environment}/{path}` | `serveSite` | MVP | Serve a file from the active deployment (CDN in production) |


**SCIM 2.0** (V1) is served at `/scim/v2/Users` and `/scim/v2/Groups` per RFC 7643/7644, with bearer-token auth issued from the admin console. It is a standard protocol, so it isn't repeated in the OpenAPI document. **GraphQL** (V1) exposes a read-only view of the same graph at `/graphql` (persisted queries, cost limits).

## 4. Webhook event catalog

Outbound events are **CloudEvents 1.0** JSON envelopes (`content-type: application/cloudevents+json`), signed per **[Standard Webhooks](https://www.standardwebhooks.com/)**. Subscriptions are managed through `POST /v1/webhook-subscriptions`.

| Event type | Fires when | `data` schema | Typical consumer |
|---|---|---|---|
| `docops.page.published` | Pages go live in an environment (diff of added, modified and removed pages) | `PagePublishedData` | Search, chat announcements, LMS sync |
| `docops.build.succeeded` | A build is ready to deploy | `Build` | Deployment orchestrators |
| `docops.build.failed` | A build failed | `Build` | Alerting |
| `docops.preview.ready` | A PR preview URL is available | `{buildId, repository, pullRequestNumber, url}` | ChatOps, review tooling |
| `docops.deployment.promoted` | A build is promoted to an environment | `Deployment` | Release dashboards, change records (ServiceNow) |
| `docops.check.completed` | A quality-gate run completes | `CheckRun` | Engineering metrics |
| `docops.drift.detected` | Drift findings are raised on a change | `{checkRunId, repository, pullRequestNumber, findings[]}` | Tech-writer queues |
| `docops.suggestion.created` | An AI suggestion awaits review | `Suggestion` | Review queues |
| `docops.suggestion.decided` | A human accepted, edited or rejected a suggestion | `Suggestion` | AI quality metrics |
| `docops.ticket.docs_status_changed` | A ticket's docs status changes | `{ticketKey, previous, current, reasons[]}` | Tracker automation, Slack |
| `docops.release.readiness_changed` | Readiness of a fix version changes | `{project, fixVersion, readyPercent, previousReadyPercent, blockers}` | Release management |
| `docops.page.stale` | A page breaches its freshness SLA or references changed entities | `{pageId, path, reason, owners[], entityKeys[]}` | Owner notifications |

**Example**

```http
POST /hooks/docops HTTP/1.1
Host: hooks.acme.example
Content-Type: application/cloudevents+json
webhook-id: msg_01JAX4Q4T8N8Y0Q8C3M6Z7V2PB
webhook-timestamp: 1760796131
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{
  "specversion": "1.0",
  "id": "01JAX4Q4T8N8Y0Q8C3M6Z7V2PB",
  "source": "docops://cells/us-1/api",
  "type": "docops.page.published",
  "subject": "spaces/payments/environments/prod",
  "time": "2026-10-18T14:02:11Z",
  "tenantid": "0192a1f0-58c2-7d3e-9b1a-2f4c6e8a0b1c",
  "datacontenttype": "application/json",
  "data": {
    "spaceKey": "payments",
    "environment": "prod",
    "versionName": "2.4",
    "audience": "public",
    "buildId": "0192a1f3-7a10-7c55-8e2f-1b3d5f7a9c0e",
    "pages": [
      { "path": "guides/refunds.md", "url": "https://docs.acme.example/2.4/guides/refunds/", "change": "modified" }
    ]
  }
}
```

**Verifying a delivery** (any Standard Webhooks library works; shown without dependencies):

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyDocOpsWebhook(secret: string, headers: Headers, rawBody: string): boolean {
  const id = headers.get("webhook-id"), ts = headers.get("webhook-timestamp");
  const sigs = headers.get("webhook-signature") ?? "";
  if (!id || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay window
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sigs.split(" ").some((s) => {
    const [version, value] = s.split(",");
    const given = Buffer.from(value ?? "", "base64");
    return version === "v1" && given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

**Delivery semantics**
- **At least once.** Consumers dedupe on `webhook-id`, which equals the CloudEvent `id`.
- **Ordering** is guaranteed per `subject`, not globally. Consumers should compare `time`, or read the resource for authoritative state.
- **Retries** follow an exponential schedule over 24 h (5 s, 5 m, 30 m, 2 h, 5 h, 10 h, 10 h). After 5 consecutive days of failures the subscription is auto-disabled, and admins are notified by email and in-app.
- **Replay.** Deliveries are retained for 30 days and can be redelivered from the admin console.
- **Security.** Endpoints must be HTTPS. Requests come from a published egress IP range per cell, and secrets rotate with an overlap window (two signatures are sent during rotation).

## 5. Inbound webhook handling

| Provider | Verification | Dedupe key | Events consumed (MVP) |
|---|---|---|---|
| GitHub App | `X-Hub-Signature-256` = `sha256=` + hex HMAC of the raw body | `X-GitHub-Delivery` | `pull_request` (opened, synchronize, closed, edited), `push`, `create` (tags), `installation`, `pull_request_review` |
| Jira Cloud (Forge) | Forge Invocation Token (JWT) | `jti` | Forge triggers: `avi:jira:created:issue`, `avi:jira:updated:issue`, `avi:jira:deleted:issue`, `avi:jira:released:version` |
| Jira Data Center / admin webhooks | `X-Hub-Signature` = `sha256=` + hex HMAC | `X-Atlassian-Webhook-Identifier` | `jira:issue_updated`, `jira:version_released` |
| GitLab (V1) | `X-Gitlab-Token` (or signing token) | `X-Gitlab-Event-UUID` | merge request, push, tag push |

Receivers verify the request, record the delivery in `webhook_deliveries`, write an outbox event and return `202` within 100 ms p99. All processing happens asynchronously in workers.
