---
title: "ADR-0002: Modular monolith first, split along queue boundaries"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/architecture"]
---

# ADR-0002: Modular monolith first, split along queue boundaries

## Context

The logical architecture has about ten services: gateway, identity, content, connectors, workers, search, AI, collaboration, notifications and audit. Self-hosted and air-gapped customers pay for every additional deployable in operational effort and security review. The team at MVP is about 7 engineers.

## Decision

Ship **three deployables**: `docops-api` (identity, content, connectors ingress, AI request path), `docops-worker` (all queue consumers, with `WORKER_QUEUES` choosing the role) and `docops-collab` (V1). Module boundaries are enforced in code: packages communicate through typed interfaces and events, and a module never reaches into another module's tables. A module splits out only when an SLO or scaling signal requires it.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Modular monolith + worker pool** | Few moving parts; transactional consistency with the outbox; easy local dev and self-hosting | Discipline needed to keep boundaries; a shared deploy cadence |
| Microservices from day one | Independent scaling and deploys | Distributed-systems tax before product-market fit; heavy for self-hosters |
| Serverless functions | Elastic | Not portable to air-gapped Kubernetes; cold starts on webhooks |

## Consequences

- Workers already scale independently by queue (KEDA on queue lag), which covers the main elasticity need.
- Split-out triggers are documented: webhook bursts degrading API p95, or AI traffic needing GPU node affinity.
