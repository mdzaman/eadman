---
title: "ADR-0003: PostgreSQL as the content-graph store"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0003: PostgreSQL as the content-graph store

## Context

The content graph links pages, revisions, entities, snapshots, tickets, PRs, commits, builds and releases. The queries we need are coverage, staleness, release readiness and traceability, and all of them are joins of at most six hops along known paths. Tenancy isolation, transactional outbox writes and residency-pinned backups are mandatory. Self-hosted customers already run Postgres.

## Decision

Model the graph **relationally in PostgreSQL 17+** (tested on 18): typed edge tables (`doc_references`, `ticket_links`, `pull_request_files`, `version_pages`), recursive CTEs where needed, and RLS for tenancy. pgvector covers embeddings in the default deployment.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **PostgreSQL** | One datastore; ACID with the outbox; RLS; PITR; universally available managed offerings; pgvector | Ad hoc deep traversals are less ergonomic |
| Neo4j / Neptune | Expressive graph queries | Extra system to secure and pin to a region; clustering licensing; no RLS equivalent |
| Document store | Flexible schema | Weak relational integrity for traceability evidence |

## Consequences

- The full DDL is the contract ([Data model §7](../03-data-model.md#7-ddl)) and stays in sync with docs through an include directive and a test.
- If analytics needs grow beyond Postgres, we stream the outbox to a warehouse rather than changing the system of record.
