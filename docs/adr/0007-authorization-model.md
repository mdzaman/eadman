---
title: "ADR-0007: In-process RBAC with ACL tags for retrieval"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0007: In-process RBAC with ACL tags for retrieval

## Context

Permissions must work at org, space and page scope; they come from SCIM groups and are bound to roles. They must be enforced in the API, in static portals (edge), in search and in AI retrieval. Retrieval needs a *filter* ("which chunks may this user see?"), not just a yes/no *check*.

## Decision

- **Role bindings** `(principal, role, scope)` are evaluated by an in-process policy engine with a deny-by-default posture.
- Each indexed chunk and each built page carries **ACL tags**: the principals allowed to read it, computed at index or build time (for example `space:<id>:read`, `group:<id>`, `tenant:*`).
- At query time the user's **principal set** (user, groups and derived tags; cached 60 s and invalidated by `acl.changed` events) becomes a mandatory filter: `acl_principals && :principals`.
- Answers and citations are re-checked against live policy before rendering, which covers revocations made after indexing.
- V2 adds **Cedar** (embedded) for attribute-based conditions such as region and classification labels, without adding a service.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **In-process RBAC + ACL tags** | No extra service; filters work natively in Postgres and OpenSearch; fast | Tags must be recomputed when ACLs change (event-driven, bounded) |
| OpenFGA / SpiceDB (Zanzibar) | Expressive relationships; `ListObjects` | Another stateful service; filter-at-retrieval needs extra plumbing |
| Post-filtering search results | Simple | Leaks through ranking, counts and timing; breaks top-k; unacceptable for AI |

## Consequences

- An ACL change triggers re-tagging of affected chunks and page manifests. The SLO is visibility within 60 s, and live re-checks cover the gap.
- Canary documents per tenant continuously assert that unauthorized content is never retrieved ([Security §2](../08-security-compliance.md#2-threat-model-stride)).
