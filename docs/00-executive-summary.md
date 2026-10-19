---
title: Executive Summary
owners: ["@docops/product"]
reviewed: 2026-10-18
status: proposed
---

# EADMan: Executive Summary

> **Promise:** Docs never drift from the code. Every release ships with accurate, traceable documentation.

## The problem

Engineering organizations publish documentation that is wrong. Usually it was right when someone wrote it, and nothing told anyone when it stopped being right. The costs show up in other people's budgets: support tickets about renamed parameters, incidents worsened by runbooks that describe last year's infrastructure, onboarding that takes weeks, and audit findings because nobody can show which document shipped with which release.

Today's tools each solve one part of this:

| Category | Examples | What breaks |
|---|---|---|
| Wikis | Confluence | Content is disconnected from code. Nothing verifies it, and versioning per release is weak. |
| Static site generators | Docusaurus, MkDocs/TechDocs | Docs live in Git, but the platform has to be built around them: there are no gates, governance, Jira traceability or AI. |
| Hosted doc portals | GitBook, ReadMe, Mintlify | They render well and editing is easy, but they mostly target external portals. Few offer self-hosting, and none have entity-level drift detection or release-readiness evidence. |
| Code-coupled docs | Swimm | Snippet-level sync for internal walkthroughs. They don't publish portals, and API, config and infrastructure aren't covered. |

## The solution

EADMan (Enterprise Application Document Management) is a docs-as-code platform built around a **content graph**: a versioned model that links every doc page to the things it describes (API operations, config keys, CLI flags, infrastructure resources), the tickets that required it, the commits and pull requests that changed it, and the releases that shipped it. That graph makes documentation **verifiable**:

1. **Connect** a repo. The `docops` CLI and extractors turn OpenAPI, AsyncAPI, GraphQL, protobuf, source code and IaC into *entities* with stable keys and fingerprints.
2. **Check every PR.** Deterministic gates catch broken links, undocumented new APIs, schema changes that arrive without doc updates, references to renamed or removed entities, failing code samples, style problems and accessibility issues. AI adds semantic drift findings, each with a quoted, cited patch suggestion that a human applies with one click.
3. **Preview, approve, merge.** Every PR gets an ephemeral rendered preview. Approval follows the Git provider's branch protection and CODEOWNERS rules.
4. **Publish with the release.** An immutable, signed build is promoted through dev → staging → prod alongside the application, versioned by Git tag, and served from a CDN to internal, partner and public audiences built from a single source.
5. **Prove it.** Jira shows the docs status of every ticket. A release-readiness view and a workflow validator block "Done" until the required docs are merged. An exportable traceability report links requirement → ticket → commit → PR → doc page → release.
6. **Answer questions.** Ask-the-docs answers only from content the asker is allowed to see, cites the exact page and version, and says "not documented" instead of guessing.

## Why EADMan wins

- **Entity-level drift detection.** Other tools work at the page level or the snippet level. A deterministic engine finds drift first. AI is added only where determinism can't reach, and its findings are advisory unless a team opts in to blocking on them.
- **Release-readiness evidence wired into Jira.** Coverage, readiness and traceability are measured continuously, so nobody has to self-report them.
- **Git is the source of truth with no lock-in.** Every fact in our database can be rebuilt from Git, the issue tracker or CI (`docops reindex`), and full export is a first-class feature.
- **Enterprise-grade from day one:** SSO, SCIM, page-level RBAC, a hash-chained audit log, data residency cells, customer-managed keys, and an air-gapped Helm deployment that can run with local LLMs.
- **Compute runs in the customer's CI.** The CLI performs extraction, checks and builds where the code already lives. That cuts our attack surface and cost, and it means air-gapped installs behave the same as SaaS.

## Architecture in one paragraph

An event-driven, modular TypeScript platform (ADR-0001, ADR-0002). Git, Jira and CI webhooks land in connectors, which write to a transactional outbox. Idempotent workers extract, check, build, index and publish. A Postgres content graph (with row-level security, using pgvector for search) indexes what Git and the trackers hold, and object storage keeps content-addressed builds. The portal is static Astro output on a CDN, so its availability doesn't depend on the application plane. AI runs through a model-agnostic gateway with permission-aware retrieval and quote-verified citations. Tenants are isolated by RLS (pooled), by a dedicated database and key (silo), or by a separate deployment (single-tenant or self-hosted), inside regional cells (US, EU, APAC). See [System Architecture](02-system-architecture.md).

## Plan and investment

| Phase | Duration | Outcome |
|---|---|---|
| **MVP** | 12 weeks, 9 FTE | GitHub plus Jira Cloud. The CLI and GitHub Action run OpenAPI drift, coverage and link gates. PR previews, a static versioned portal, the Jira docs panel with release readiness, OIDC SSO, basic RBAC and an audit log. AI patch suggestions ship as an opt-in beta. |
| **V1** | Months 4–9 | WYSIWYG editor with real-time collaboration; GitLab, Bitbucket and Azure DevOps; Jenkins and GitLab CI; AsyncAPI, GraphQL, protobuf and SDK extractors; doc tests; WCAG checks; Ask-the-docs; SAML and SCIM; Helm self-hosting; EU region; SOC 2 Type II. |
| **V2** | Months 10–18 | Air-gapped installs with local LLMs; APAC region; BYOK; IaC and database extractors; localization; gap analysis from support tickets; signed traceability exports; plugin marketplace; ISO 27001 and HIPAA. |

## North-star metrics

| Metric | MVP exit target | V1 target |
|---|---|---|
| Doc coverage of public API operations, measured by L2 guides | 60% | 85% |
| Escaped drift (drift found after merge, per 100 changed entities) | < 5 | < 1 |
| Release readiness at release cut | 80% | 95% |
| Precision of deterministic drift findings | ≥ 95% | ≥ 97% |
| AI citation accuracy (quote-verified) | n/a | ≥ 98%, with zero permission leaks |

Every metric is defined in [Product Requirements § Success metrics](01-product-requirements.md#10-success-metrics-and-how-they-are-measured).

## Key risks and mitigations

| Risk | Mitigation |
|---|---|
| False positives erode trust in the gates | Deterministic-first engine; AI findings never block by default; one-click dismissal with a reason feeds back into the rules; precision is a release metric. |
| WYSIWYG ↔ MDX round-trip loses content | Unsupported MDX stays an opaque, code-editable node. A fidelity test suite of more than 500 real documents runs in CI. |
| Integration breadth slows delivery | Connector SDK with a contract-test kit; ship GitHub and Jira Cloud first. |
| Enterprise security review blocks deals | Self-hosted from V1, SOC 2 evidence collected from the MVP onward, and a published threat model ([Security](08-security-compliance.md)). |
| LLM cost or data-leak concerns | AI is opt-in per tenant. Tenants can bring their own model, including self-hosted. Retrieval is filtered by permission, and leakage canaries are tested continuously. |

## Deliverables in this package

1. [Product requirements](01-product-requirements.md): personas, jobs to be done, user stories with acceptance criteria, non-goals and metrics
2. [System architecture](02-system-architecture.md): component and sequence diagrams, storage, tenancy, SLOs
3. [Data model](03-data-model.md): content-graph ERD and full DDL
4. [API design](04-api-design.md): the [OpenAPI 3.1 spec](../api/openapi.yaml) and the webhook event catalog
5. [CLI and CI](05-cli-and-ci.md): `docops` commands, the [`docops.yaml` schema](../packages/config/schema/docops.schema.json), and pipelines for GitHub, GitLab and Jenkins
6. [Jira integration](06-jira-integration.md): Forge app, custom fields, automation rules
7. [AI design](07-ai-design.md): RAG, the drift algorithm, prompts, evaluation, guardrails
8. [Security and compliance](08-security-compliance.md): STRIDE threat model, RBAC matrix, audit schema
9. [Roadmap](09-roadmap.md): MVP, V1 and V2 scope, team, milestones
10. [MVP scaffold](10-mvp-scaffold.md): a working monorepo with the CLI, services, GitHub Action, Jira linking, the OpenAPI renderer and tests
11. [Competitive positioning](11-competitive-positioning.md)

Architecture decisions are recorded as ADRs in [`docs/adr/`](adr/README.md).
