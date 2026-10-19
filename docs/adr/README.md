---
title: Architecture Decision Records
owners: ["@docops/architecture"]
reviewed: 2026-10-18
---

# Architecture Decision Records

These ADRs use the template that DocOps ships (`docops new adr`): context, decision, options considered, consequences. ADRs are immutable once accepted. To change a decision, write a new ADR that supersedes the old one.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-typescript-everywhere.md) | TypeScript across services, CLI, actions and UI | Accepted |
| [0002](0002-modular-monolith-first.md) | Modular monolith first, split along queue boundaries | Accepted |
| [0003](0003-postgres-content-graph.md) | PostgreSQL as the content-graph store | Accepted |
| [0004](0004-outbox-and-queue.md) | Transactional outbox; Postgres queue by default, Kafka in scale mode | Accepted |
| [0005](0005-search-backend.md) | Search backend: Postgres FTS + pgvector, OpenSearch at scale | Accepted |
| [0006](0006-tenancy-isolation.md) | Tiered tenant isolation inside regional cells | Accepted |
| [0007](0007-authorization-model.md) | In-process RBAC with ACL tags for retrieval | Accepted |
| [0008](0008-portal-and-editor.md) | Astro portal; TipTap + Yjs editor with opaque MDX nodes | Accepted |
| [0009](0009-jira-forge-app.md) | Forge for Jira Cloud; REST-only integration for Data Center | Accepted |
| [0010](0010-compute-in-customer-ci.md) | Run extraction, checks and builds in the customer's CI | Accepted |
