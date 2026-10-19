---
title: "ADR-0005: Search backend: Postgres FTS + pgvector, OpenSearch at scale"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0005: Search backend: Postgres FTS + pgvector, OpenSearch at scale

## Context

Search needs hybrid relevance (keyword plus semantic), filters for version, audience and product, **mandatory permission filtering**, p95 < 200 ms, and ACL changes visible within 60 s. Self-hosted customers resist operating an extra search cluster.

## Decision

Put a `SearchBackend` interface in front of two implementations:

- **Postgres** (default): `tsvector` with GIN for BM25-like ranking, pgvector HNSW for semantic search, Reciprocal Rank Fusion in SQL, and ACL tags (`text[]`) with GIN and the `&&` operator. ACL updates are transactional.
- **OpenSearch** (scale mode): BM25 plus k-NN with the hybrid query and normalization processor, a document-level `acl_principals` keyword field, and per-tenant indices or routing.

The filter on principals is a **required parameter** of `query()`. There is no code path that searches without one.

## Options considered

| Option | Relevance | Ops | Permission filtering | Fit |
|---|---|---|---|---|
| **Postgres FTS + pgvector** | Good | None extra | Transactional, exact | Default, up to about 5M chunks per tenant |
| **OpenSearch** | Best keyword relevance, analyzers, languages | Cluster to run | Filter clauses; eventual | Large tenants and SaaS cells |
| Hosted search (Algolia) | Excellent UX | SaaS only | Secured API keys | Rejected: not self-hostable, content leaves the region |

## Consequences

- A parity test suite runs the same queries and ACL scenarios against both backends.
- Public portals also ship a static Pagefind index, so search survives an outage of the application plane.
