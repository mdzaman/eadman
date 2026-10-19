---
title: "ADR-0006: Tiered tenant isolation inside regional cells"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0006: Tiered tenant isolation inside regional cells

## Context

Customers range from 20-person teams to regulated enterprises that need dedicated infrastructure, customer-managed keys, data residency or air-gapped installs. One codebase has to serve all of them.

## Decision

- **Regional cells** (US, EU, APAC), each a complete stack. A tenant is pinned to its home cell, and the global plane stores only routing.
- **Isolation tiers** inside a cell: *Pooled* (shared database with RLS and a per-tenant DEK), *Silo* (a dedicated database, index, bucket and KEK, with optional CMK), *Dedicated* (a dedicated cluster), and *Self-hosted* (customer infrastructure). They share code; a tenant router resolves the connection, index and bucket per tenant.
- RLS is mandatory even in silo and dedicated tiers, so there is one security model and no special cases.

## Options considered

| Option | Isolation | Cost per tenant | Operability |
|---|---|---|---|
| Pooled only | Logical | Lowest | Simple, but fails regulated buyers |
| Database per tenant for everyone | Strong | High | Thousands of databases to migrate |
| **Tiered (pooled, silo, dedicated, self-hosted)** | Matches the buyer | Proportional | One codebase; the router abstracts placement |

## Consequences

- Tenants can move between tiers through export and import within a cell (`docops-admin tenant move`), planned for V1.
- Noisy-neighbor protections (per-tenant job concurrency, rate limits, build quotas) are needed in the pooled tier.
