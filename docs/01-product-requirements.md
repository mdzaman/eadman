---
title: Product Requirements Document
owners: ["@docops/product"]
reviewed: 2026-10-18
status: proposed
---

# DocOps: Product Requirements Document

| | |
|---|---|
| **Status** | Proposed for MVP commitment |
| **Owners** | Product (PM), Engineering (EM), Design |
| **Related** | [Executive Summary](00-executive-summary.md), [System Architecture](02-system-architecture.md), [Roadmap](09-roadmap.md) |

## 1. Problem statement

Documentation in engineering organizations decays silently. Code, APIs, config and infrastructure change many times a day, but the docs that describe them change only when someone remembers. No system knows which doc describes which part of the system, so drift can't be detected, coverage can't be measured, and nobody can show which documentation shipped with a release.

DocOps makes documentation a **versioned, verifiable product of the delivery pipeline**. A page is linked to the entities it describes, the tickets that required it and the releases that shipped it. Every change is checked against those links before merge.

## 2. Assumptions

Each assumption here is explicit and testable. If one proves false, the scope in the [Roadmap](09-roadmap.md) changes.

| ID | Assumption | How we will validate it |
|---|---|---|
| A1 | Buyers are engineering organizations with 200–20,000 engineers that use GitHub, GitLab, Bitbucket or Azure DevOps together with Jira. | Design-partner pipeline: 8 partners signed before MVP build week 4 |
| A2 | Most teams already keep *some* docs in Git (README files, ADRs, MkDocs or Docusaurus sites). Migration is about importing structure, not converting formats. | Discovery interviews; repository census of partners |
| A3 | Developers will accept CI gates if precision is ≥ 95% and every finding has a one-click fix or dismissal. | MVP beta: dismissal rate < 10% |
| A4 | Tech writers will adopt Git-backed editing only through a WYSIWYG editor that never shows them Git concepts they don't want. | V1 usability tests (task success ≥ 90%) |
| A5 | Customer CI is the main compute for checks and builds. Hosted runners are needed only for edits made in the browser. | Partner CI census; hosted build minutes in beta |
| A6 | AI is opt-in, and a significant minority of tenants (regulated industries) will never enable a third-party LLM. Deterministic features must deliver value alone. | Value proof in the MVP without AI enabled |
| A7 | Jira Cloud covers ≥ 70% of target accounts at MVP. Jira Data Center accounts remain material until Atlassian's Data Center end of life. | Partner census |
| A8 | Scale targets: the largest tenant has 50k pages, 2k repositories and 10k users; SaaS reaches 1k tenants by the end of V1. | Capacity model in [Architecture §9](02-system-architecture.md#9-scalability-performance-and-slos) |

## 3. Personas

| Persona | Role | Goals | Frustrations today | Primary surfaces |
|---|---|---|---|---|
| **Dana**, Developer | Backend engineer shipping API changes weekly | Ship features without a separate docs chore; know quickly when a change breaks docs | Updates docs in another tool; finds out about stale docs from support tickets | IDE extension, PR checks, CLI |
| **Wes**, Technical Writer | Owns information architecture, voice and editorial quality | Edit rich content without fighting Git; review developer changes; enforce style | Merge conflicts, raw MDX, no view of what changed in the product | WYSIWYG editor, review queue, style dashboard |
| **Rita**, Release / Engineering Manager | Runs release trains; accountable for release quality | Know before the release cut which features are undocumented; produce release notes quickly | Spreadsheet-based readiness, chasing people in Slack | Jira readiness view, release notes, coverage dashboard |
| **Sam**, SRE / Platform Engineer | Owns runbooks, ADRs and postmortems for 40 services | Runbooks that match production; fast search during incidents, even offline | Runbooks reference retired infrastructure; search is slow | Portal search, runbook templates, freshness alerts |
| **Priya** (Product), **Sol** (Support), **Casey** (Customer developer) | Consumers of published docs | Correct answers for *their* version and audience, fast | Version confusion, contradicting pages, unanswered searches | Public, partner and internal portals; Ask-the-docs |
| **Avery**, Auditor / GRC | Collects change-management evidence (SOC 2 CC8, ISO 27001 A.8.32) | Show requirement → change → doc → release for sampled changes | Evidence assembled by hand from five tools | Traceability report, audit log export |
| **Ian**, IT / Platform Admin | Owns identity, procurement, deployment | SSO and SCIM, least-privilege access, data residency, self-hosting | Tools that can't satisfy security review | Admin console, Helm chart, SIEM export |

## 4. Jobs to be done

Each job is written as *When … I want to … so I can …*.

| ID | Persona | Job |
|---|---|---|
| J1 | Dana | When I change a public API, I want to be told exactly which docs are now wrong and get a suggested fix in my PR, so I can ship accurate docs without context switching. |
| J2 | Dana | When I add a new endpoint, config key or flag, I want a doc stub generated from the code, so I can start from something rather than nothing. |
| J3 | Wes | When developers change product behavior, I want a queue of doc-impacting changes ranked by audience impact, so I can spend editorial time where it matters. |
| J4 | Wes | When I edit a page, I want a rich editor that commits clean Markdown/MDX through review, so I can work in Git without learning Git. |
| J5 | Rita | When a release is approaching, I want to see which tickets in the fix version have merged docs and which don't, so I can unblock or descope before the cut. |
| J6 | Rita | When we release, I want release notes drafted from merged PRs and tickets, so I can publish them the same day. |
| J7 | Sam | When an incident starts, I want the right runbook for the deployed version in seconds, and I want to trust that it's current, so I can restore service faster. |
| J8 | Sam | When infrastructure changes, I want runbooks and diagrams that reference the changed resources flagged, so I can keep operational docs truthful. |
| J9 | Casey | When I integrate with the API, I want docs for my exact version, with runnable examples and a try-it console, so I can integrate without filing a ticket. |
| J10 | Sol | When a customer asks a question, I want a cited answer from the docs or a clear "not documented", so I can respond confidently and log the gap. |
| J11 | Avery | When an auditor samples a change, I want one report linking requirement → ticket → commit → PR → doc → release with timestamps and approvers, so I can produce evidence in minutes. |
| J12 | Ian | When we onboard the platform, I want SSO, SCIM, RBAC, audit export and a deployment model that satisfies our security policy, so I can approve it without exceptions. |

## 5. Scope: epics and user stories

Priorities: **MVP** (weeks 1–12), **V1** (months 4–9), **V2** (months 10–18). Acceptance criteria use *Given / When / Then* and are written to be automatable. Story IDs are stable and are referenced from tests and Jira.

### E1. Git-native content layer

**US-GIT-01 (MVP): Connect a repository**
*As Dana, I want to connect a GitHub repository with docs in `docs/`, so that DocOps indexes and builds them.*
- Given the DocOps GitHub App is installed on `acme/payments`, when an admin selects the repository and confirms `docs/` as the docs root, then DocOps indexes all `*.md`/`*.mdx` files on the default branch within 5 minutes for repositories with ≤ 5k pages.
- Given `docops.yaml` exists at the repository root, when it fails schema validation, then the connection is marked *Needs attention* and the errors show the file path, line and the JSON pointer of each error.
- Given the repository is disconnected, then all derived data for it is deleted within 24 hours, and Git content is untouched.

**US-GIT-02 (MVP): PR preview**
*As a reviewer, I want every PR to get a rendered preview URL, so that I review docs as readers will see them.*
- Given a PR changes any file under the docs root or any configured source (for example `api/openapi.yaml`), when the CI job `docops build --preview` completes, then the PR has a comment and a check-run link to `https://preview.docops.example/<tenant>/<repo>/pr-<n>/` within p95 3 minutes of push.
- The preview requires the viewer to be authenticated as a tenant member with read access to the repository. It sends `X-Robots-Tag: noindex` and expires 7 days after the PR closes.
- Each subsequent push updates the same preview URL; earlier builds stay addressable by commit SHA.

**US-GIT-03 (MVP): Versions from Git tags**
*As Casey, I want to select the docs version that matches my API version.*
- Given `versions.strategy: git-tags` with `tagPattern: v*`, when tag `v2.4.0` is pushed, then a version `2.4` is built and published, and the version selector lists the newest *N* (`versions.keep`) versions plus `latest`.
- Given a page doesn't exist in the selected version, then the selector links to the closest ancestor page in that version and never returns a 404 without explanation.

**US-GIT-04 (V1): Two-way WYSIWYG ↔ Git sync**
*As Wes, I want my editor changes to become commits and pull requests, and Git commits to show up in the editor.*
- Given Wes edits a page in the editor, when he clicks *Propose changes*, then a branch `docops/<user>/<slug>-<shortid>` and a PR are created with Wes as the commit author (through a user-to-server token), containing only Markdown/MDX diffs.
- Given a commit lands on the branch Wes is editing, then the editor merges it into the live document (CRDT rebase) without losing either side, or opens a conflict view if the same block changed.
- Given a document contains MDX the editor can't represent, then that block appears as an editable "MDX source" block, and a round trip with no edits produces a byte-identical file.

**US-GIT-05 (V1): GitLab, Bitbucket and Azure DevOps**
- Parity with US-GIT-01 to US-GIT-03 for GitLab (SaaS and self-managed ≥ 16.x), Bitbucket Cloud and Data Center, and Azure DevOps Services and Server. The connector contract-test kit passes for every provider.

### E2. CI/CD integration and quality gates

**US-CI-01 (MVP): Quality gates in CI**
*As Dana, I want `docops check` to run in my pipeline and fail only on findings my team configured to block.*
- Given `checks.links.level: block`, when a page links to a missing page or anchor, then `docops check` exits `1` and prints `links/broken-internal` with file, line and target.
- Given a rule set to `warn`, then findings are reported, but the exit code stays `0`.
- Output formats: `text`, `json`, `sarif` (GitHub code scanning), `markdown` (PR comment), `junit`, `codequality` (GitLab). Each finding includes its rule ID, severity, location and a fingerprint that stays stable across runs.

**US-CI-02 (MVP): Schema change without doc update**
*As Rita, I want PRs that change a public API schema to be blocked unless the docs change too.*
- Given `api/openapi.yaml` changes an operation in a user-visible way (added, removed or renamed operation, parameter, property or enum value, or a change in required, type or default), when no doc page that references the affected entities is modified in the PR, then the finding `schema/changed-without-docs` is raised at the configured level.
- Given the PR has the label `docs-not-needed` and the author is a maintainer, then the finding is downgraded to `info`, and the waiver is recorded in the audit log with the reason taken from the PR body.

**US-CI-03 (MVP): Drift on renamed or removed entities**
*As Dana, I want to know which sentences reference something my change removed or renamed.*
- Given operation parameter `amount` is renamed to `amount_cents`, when page `guides/payments.md` mentions `amount` in an inline code span or code block in the context of `POST /v1/payments`, then `drift/stale-reference` is raised at that line. The finding includes a deterministic replacement suggestion that renders as a GitHub ```` ```suggestion ```` block.
- Precision on the labeled MVP drift corpus is ≥ 95% (see [AI design §6](07-ai-design.md#6-evaluation-harness)).

**US-CI-04 (MVP): Coverage of new public entities**
- Given a new public operation `GET /v1/refunds/{id}` with no doc reference, then `coverage/undocumented-entity` is raised. When `coverage.minimum: 80` and coverage drops below 80%, then `coverage/below-threshold` is raised.
- Entities marked `x-internal: true`, `@internal` or `deprecated` are excluded from the denominator unless `coverage.includeDeprecated: true` is set.

**US-CI-05 (V1): Doc tests**
*As Casey, I want code samples that work.*
- Given a fenced block with ```` ```bash test ```` or ```` ```python test ````, when `docops test` runs, then the block runs in an isolated working directory with the configured timeout (default 30 s), and a non-zero exit or a mismatched `expect` output raises `doctest/failed` with captured stderr.
- Given `env` placeholders such as `{{API_BASE_URL}}`, then they resolve from the CI environment and never print in logs.

**US-CI-06 (V1): Style and accessibility**
- Vale-compatible style rules run with the repository's `.vale.ini`. Built-in rules cover inclusive language, non-descriptive link text and heading order.
- Accessibility checks with axe-core against the rendered preview fail on any WCAG 2.2 AA violation configured as `block`.

**US-CI-07 (MVP): Publish and promote with the application**
- Given `publish.environments` defines `dev`, `staging` and `prod`, when `docops publish --env staging --build <id>` runs from the application's deployment pipeline, then the exact immutable build (same content hash) is promoted without rebuilding, and `deployment.promoted` is emitted.
- Promotion to `prod` requires that build's signature to verify and, if `requireApproval: true`, an approval recorded through the CI provider's environment protection or the DocOps UI.

**US-CI-08 (V1): Release notes**
- Given tag range `v2.3.0..v2.4.0`, when `docops release-notes` runs, then notes are grouped by PR label (`feature`, `fix`, `breaking`, `deprecation`), linked to Jira keys, and written to `docs/release-notes/2.4.0.md` as a PR (never merged automatically).
- With `--ai`, an AI-polished draft is attached as a suggestion. Every bullet cites the PRs or tickets it came from.

### E3. Jira and issue-tracker integration

**US-JIRA-01 (MVP): Bidirectional links**
*As Rita, I want doc pages and Jira issues linked automatically.*
- Given a PR whose title, branch or commits contain `PAY-123` and that modifies `docs/guides/refunds.md`, when the PR merges, then `PAY-123` shows the page in the DocOps issue panel and as a Jira remote link, and the page footer shows `PAY-123`.
- Given a page's frontmatter has `tickets: [PAY-123]`, then the same link exists even without a PR reference.
- Links created from the Jira panel are stored in Jira (as issue properties and remote links) and indexed by DocOps. No link exists only in the DocOps database.

**US-JIRA-02 (MVP): Docs status in Jira**
- Each linked issue has a read-only custom field **Docs status** with one of `Not required`, `Missing`, `In review`, `Merged`, `Published` or `Stale`. The field is JQL-searchable and updates within 60 s of the triggering event.

**US-JIRA-03 (MVP): "Docs required" enforcement**
- Given an issue has `Docs required = Yes`, when a user transitions it to *Done* and Docs status is not `Merged` or `Published`, then the workflow validator blocks the transition with the message "Docs required: link a merged doc change or set Docs required = No with a reason".
- Setting `Docs required = No` on an issue of a configured type (for example *Story* with component *Public API*) requires a reason, which is written to the audit log.

**US-JIRA-04 (MVP): Release readiness**
*As Rita, I want a readiness view per fix version.*
- Given fix version `2.4.0` with 40 issues, when Rita opens *Docs readiness*, then she sees counts and a filterable list per status, a readiness percentage (defined in §10), and "Create doc tasks" for issues whose status is `Missing`.
- The view loads p95 < 2 s for ≤ 500 issues. Data is at most 60 s stale.

**US-JIRA-05 (V1): Auto-create doc tasks**
- Given a merged PR changes a public schema entity referenced by no page, then a *Doc task* sub-task is created under the originating issue (or in the space's default project if there is none), assigned to the page owner or space owner, and deduplicated by entity key.

**US-JIRA-06 (V1/V2): Other trackers**
- Jira Data Center (V1, REST-only integration), Linear, Azure Boards and GitHub Issues (V2) through the tracker connector SDK, with the same link semantics.

### E4. Auto-generated reference documentation

**US-REF-01 (MVP): OpenAPI reference**
- Given a `sources[]` entry of `type: openapi` (3.0 or 3.1), then the build generates an index page, one page per tag and one page per operation. Each operation page shows parameters, request body, responses, schemas (resolving `$ref`, `allOf`, `oneOf` and `anyOf`), security requirements and generated `curl` and JavaScript examples, with stable anchors.
- Remote `$ref` resolution is disabled unless allowlisted.

**US-REF-02 (V1): Try-it console**
- Casey can choose an environment (from `servers` or overrides in `docops.yaml`) and enter credentials, which are kept only in memory for the tab's lifetime, then send a request and see the response. The console is fully keyboard-operable and announces responses through an `aria-live` region.

**US-REF-03 (V1): AsyncAPI, GraphQL, protobuf**, with the same entity model and coverage semantics.

**US-REF-04 (V1/V2): SDK and infrastructure reference**
- V1: TypeScript, Python, Java, Go, C# and Rust symbol extraction through language-native tools (TypeDoc JSON, griffe, javadoc doclet, go/doc, Roslyn XML docs, rustdoc JSON).
- V2: Terraform, CloudFormation/CDK, Helm and Kubernetes; database schema docs from migrations.

**US-REF-05 (V1): Diagrams as code**
- Mermaid, PlantUML and Structurizr DSL blocks render to accessible SVG with a text alternative, and are versioned with the page.

### E5. AI layer

**US-AI-01 (MVP beta): Drift patch suggestions**
- Given a deterministic drift finding and AI enabled for the tenant, then a patch limited to the flagged lines is posted as a GitHub suggestion. It shows the model, prompt template version and the sources used. It is never committed without a human clicking *Commit suggestion*.

**US-AI-02 (V1): Semantic drift**
- Given a code diff that changes behavior (for example a default timeout from 30 s to 60 s in code), when a page states "times out after 30 seconds", then `drift/semantic` (warning) is raised. It quotes the exact sentence (verified verbatim) and cites the diff lines.

**US-AI-03 (V1): Ask-the-docs**
- Answers draw only on chunks the asker may read (filtered *before* retrieval). Every sentence carries a citation to page, version and anchor. Each citation's quote is verified verbatim against the source. When retrieval sufficiency is below threshold, the reply is "This isn't documented", along with an option to file a gap.
- No answer may cite a page the user can't open. A continuous canary test enforces this.

**US-AI-04 (V1): Draft generation**
- Templates for how-to, runbook, ADR, postmortem and release notes generate drafts from tickets, PRs and code. Drafts open as PRs labeled `ai-draft` and must be approved by a human reviewer who isn't the bot.

**US-AI-05 (V2): Gap analysis**
- Top unanswered queries, zero-result searches and support tickets (Zendesk, ServiceNow, JSM) are clustered weekly into backlog items with frequency and a sample of queries, then pushed to Jira as candidate doc tasks.

**US-AI-06 (MVP): AI governance**
- AI is disabled by default. Org admins choose the provider (including self-hosted) and region, and opt in per space. Customer content is never used for training. Every AI interaction is audited.

### E6. Authoring experience

**US-AUTH-01 (V1):** A block-based WYSIWYG editor (TipTap/ProseMirror) with real-time collaboration (Yjs), presence, comments, suggestion mode and approvals mapped to PR reviews.

**US-AUTH-02 (MVP):** MDX components: `Tabs`, `Callout` (also GFM alerts `> [!NOTE]`), `CodeGroup`, `ApiOperation`, `Mermaid`, `JiraStatus` and `FeatureFlag`, rendered accessibly and degrading to readable Markdown on GitHub.

**US-AUTH-03 (MVP):** Snippets (`docs/_snippets/*.md`) and variables (`variables:` in `docops.yaml`) are reusable across pages. Changing a snippet triggers rebuilds of exactly the pages that depend on it.

**US-AUTH-04 (MVP):** `docops new <template>` scaffolds the API guide, tutorial, how-to, runbook, ADR, postmortem, onboarding and release-notes templates with required frontmatter.

**US-AUTH-05 (V1):** VS Code and JetBrains extensions offer live preview, lint-as-you-type, entity autocomplete (`entities:` frontmatter) and "go to definition" from a doc reference to the OpenAPI operation.

### E7. Publishing and discovery

**US-PUB-01 (MVP):** A static portal on a CDN with custom domains (automatic TLS) and white-label theme tokens. Pages score ≥ 95 in Lighthouse performance and accessibility on a mid-range mobile profile.

**US-PUB-02 (V1):** Multiple audiences from one source. Frontmatter `audience: [public, partner]` and `<Audience only="internal">` blocks produce separate builds. Content excluded from an audience never appears in that audience's HTML, search index or sitemap; tests verify this per build.

**US-PUB-03 (MVP keyword, V1 hybrid):** Search filtered by product, version and audience. MVP uses a static index (Pagefind) on public portals. V1 adds hybrid BM25 plus vector search through the API, filtered by permission, with p95 < 200 ms.

**US-PUB-04 (V2):** Localization: extraction to XLIFF, translation memory, machine translation with human review, per-locale freshness relative to the source revision.

**US-PUB-05 (V1):** Analytics: page views, search success, zero-result queries, feedback ratings, time to answer and dead ends. Collection is privacy-preserving (no third-party trackers; IP truncated; consent-aware).

### E8. Enterprise governance

**US-GOV-01 (MVP: OIDC; V1: SAML and SCIM):** SSO through OIDC (Okta, Entra ID, Google) and SAML 2.0. SCIM 2.0 provisions users and groups, and deprovisioning revokes sessions and tokens within 60 s.

**US-GOV-02 (MVP: org and space; V1: page):** RBAC with roles bound to users, groups and service accounts at org, space or page scope. Page-level restrictions propagate to search and AI within 60 s (see the [RBAC matrix](08-security-compliance.md#3-rbac-matrix)).

**US-GOV-03 (MVP):** An append-only, hash-chained audit log of every edit, publish, permission change, gate override and AI interaction. It is exportable to S3 (Object Lock), Splunk HEC and syslog (OCSF-mapped).

**US-GOV-04 (V1):** CODEOWNERS-style ownership with freshness SLAs per path or page type. Reminders go out at 80% and 100% of the SLA, and `freshness/overdue-review` findings are raised.

**US-GOV-05 (V1: report; V2: signed export):** A traceability report for a release or a sampled change that is exportable as CSV, JSON and PDF, plus a signed evidence bundle (in-toto attestation) in V2.

**US-GOV-06 (MVP: SaaS US and docker-compose evaluation; V1: Helm and EU; V2: air-gapped, APAC and BYOK):** Deployment options and data residency.

## 6. Non-goals

| Non-goal | Rationale |
|---|---|
| General-purpose wiki for non-technical content (HR policies, meeting notes) | Confluence and Notion serve this well. We integrate with them and import from them, and don't compete. |
| Hosting source code or replacing the Git provider's review UI | Git hosts are the system of record for code and review. We add to their pull requests and don't replace them. |
| An issue tracker | We read and write Jira and other trackers. We don't store or manage tickets ourselves. |
| AI that publishes without human approval | This contradicts the core principle. Every AI output is a suggestion that has to be approved. |
| A proprietary content format | Markdown, MDX, AsciiDoc, OpenAPI and Mermaid only. Word and Confluence storage formats are *import* sources. |
| Marketing-site CMS (landing pages, A/B testing) | The audience and tooling are different. |
| API gateway, mocking or API-usage analytics (ReadMe's "API logs") | Out of scope until V2+. We integrate where needed. |
| Training or fine-tuning foundation models on customer content | Prohibited by policy and by contract. |
| A full internal developer portal (service catalog, scaffolder) | Backstage owns this. We ship a Backstage plugin rather than compete. |

## 7. Functional requirements summary

| Area | MVP | V1 | V2 |
|---|---|---|---|
| Git providers | GitHub (cloud, GHES ≥ 3.12) | GitLab, Bitbucket, Azure DevOps | — |
| Formats | Markdown, MDX | AsciiDoc | — |
| Reference sources | OpenAPI 3.0/3.1, JSON Schema config | AsyncAPI, GraphQL, protobuf, 6 SDK languages | Terraform, CDK, Helm, K8s, DB migrations |
| CI | CLI (any CI), GitHub Action | GitLab component, Jenkins, Azure Pipelines, CircleCI orb, Bitbucket Pipe | ArgoCD integration |
| Gates | links, coverage, schema change, deterministic drift, frontmatter, secrets | doc tests, Vale style, axe a11y, semantic drift | custom plugin rules marketplace |
| Trackers | Jira Cloud | Jira DC (REST) | Linear, Azure Boards, GitHub Issues |
| AI | Drift patch suggestions (beta) | Ask-the-docs, drafts, semantic drift, release notes | Gap analysis, local LLM packs |
| Portal | Static, versions, Pagefind search, custom domain | Audiences, hybrid search, try-it, analytics | Localization |
| Identity | OIDC SSO, org and space RBAC, API tokens, CI OIDC exchange | SAML, SCIM, page-level ACL | Cedar ABAC policies |
| Deploy | SaaS (US), docker-compose evaluation | Helm self-hosted, EU cell | Air-gapped, APAC, BYOK, single-tenant |

## 8. Non-functional requirements

| Category | Requirement |
|---|---|
| Performance | Full build of 5k pages p95 < 60 s on hosted workers; incremental build of a 10-page change p95 < 10 s. Search p95 < 200 ms. Portal TTFB p95 < 100 ms (CDN). AI answer time to first token p95 < 2.5 s. |
| Availability | Portal 99.95% monthly. API and control plane 99.9%. Gates **fail open with a warning** if the platform is unreachable (configurable to fail closed). |
| Scalability | 50k pages, 2k repositories and 10k users per tenant; 1k tenants per cell. |
| Security | OWASP ASVS L2. Annual third-party pen test. Customer code executes only in the customer's CI or in sandboxed microVMs. |
| Privacy | GDPR (DPA, DSAR within 30 days); no third-party trackers on portals; AI opt-in. |
| Accessibility | WCAG 2.2 AA for the portal, editor and admin UI; keyboard-first (every action reachable without a mouse, with a visible focus indicator and command palette `⌘K`). |
| Portability | Full export: Git already holds the content, and the metadata exports as JSONL with documented schemas. Only open formats. |
| Operability | OpenTelemetry traces, metrics and logs; SLOs with burn-rate alerts; runbooks for every alert (dogfooded). |
| Offline | The CLI runs every deterministic check with `--offline`. Self-hosted installs need no internet egress. |

## 9. User experience principles

1. **Meet people where they work.** Dana's surfaces are the PR and the IDE; Wes's is the editor; Rita's is Jira. The web app is the hub, not the only door.
2. **Every finding is actionable.** Each one shows a location, the reason, evidence and a one-click resolution (fix, suggestion or dismissal with a reason).
3. **Explain, don't just enforce.** A blocked gate links to the rule's documentation and the evidence diff.
4. **AI is visibly marked.** AI content carries a badge, its provenance and sources, and is never indistinguishable from human-written text.
5. **Keyboard-first and accessible by default.** Accessibility checks run on our own UI in CI.

## 10. Success metrics and how they are measured

All metrics are computed per tenant, space and version from the content graph and event stream. Definitions are versioned (`metrics/v1`) so trends stay comparable.

| Metric | Definition | Data sources | Granularity | Target |
|---|---|---|---|---|
| **Doc coverage %** | `documented_public_entities / public_entities` per entity kind. *L1* means a generated reference exists with a non-empty human description. *L2* means at least one guide, how-to or tutorial references the entity explicitly or by contextual mention. Excludes `internal` entities, and `deprecated` ones unless configured. | `entities`, `doc_references`, `page_revisions` at the published version | Version, space, kind | L1 ≥ 95%, L2 ≥ 85% (V1) |
| **Drift rate** | Drift findings (deterministic, plus AI findings that were accepted) attributed to changes in the release window, divided by changed public entities in the window, × 100. Also reported raw per release. | `findings` (category `drift`), `entity_snapshots` diffs | Release | Trend down by 50% in 2 quarters |
| **Escaped drift** | Drift findings first detected *after* the introducing change merged (nightly full scans, reader feedback tagged "incorrect"), per 100 changed entities. | `findings.detected_at` vs the introducing commit's merge time | Release | < 1 (V1) |
| **Mean time to fix drift** | Mean of `resolved_at − introduced_at` over drift findings. A finding fixed in the PR that introduced it counts as 0, which is "prevented drift"; the prevented share is reported separately. | `findings` | Month | < 2 business days |
| **Freshness** | Pages where `now − last_reviewed_at ≤ SLA(page type)` **and** no referenced entity has changed since the last review, divided by pages with an SLA. Review sources: frontmatter `reviewed:` date or an approving PR review touching the page. | `page_revisions`, `page_reviews`, `entity_snapshots` | Space | ≥ 90% |
| **Search success rate** | Search sessions with a result click and dwell ≥ 30 s (or positive feedback) and no reformulation within 60 s, divided by all search sessions. Also tracked: zero-result rate and time to first meaningful click. | Portal analytics events (`search.performed`, `search.result_clicked`, `page.dwell`) | Day | ≥ 70% success, < 5% zero-result |
| **AI citation accuracy** | Offline: share of cited claims judged *supported* by the cited quote (LLM judge calibrated to human labels, κ ≥ 0.7), plus quote-validity rate (deterministic). Online: share of a weekly human-audited sample with correct citations. Hard gate: **0** permission-leak citations. | Eval harness, `ai_answers`, review queue | Weekly | ≥ 98% supported; 100% valid quotes |
| **Abstention accuracy** | On the unanswerable eval subset, the share answered "not documented". | Eval harness | Weekly | ≥ 95% |
| **Release readiness** | For a fix version: `(published + merged + not_required) / total issues`, where *not_required* requires a recorded reason. Blockers: `missing + stale`. Snapshotted at the release cut. | `tickets`, `ticket_links`, `pull_requests`, `deployments` | Release | ≥ 95% at cut (V1) |
| **Support ticket deflection** | (a) Widget deflection: support-form sessions that viewed a suggested article or AI answer with positive feedback, or that abandoned the form within 10 min of viewing, divided by support-form sessions. (b) Trend: tickets per 1k active API consumers, compared with a pre-adoption baseline and matched control products. | Portal events, help-desk connector (Zendesk, ServiceNow, JSM) | Month | ≥ 20% widget deflection |
| **Gate precision** | `1 − dismissed_as_false_positive / findings_raised` per rule. A rule below 90% for two weeks is auto-demoted to `warn` and flagged for review. | `findings.status` and dismissal reasons | Week | ≥ 95% deterministic |
| **Time to docs** | Median time from merge of a user-facing change to the corresponding doc publication in prod. | `pull_requests`, `deployments` | Release | Same day |

## 11. Dependencies, risks and open questions

| Type | Item | Owner | Resolution path |
|---|---|---|---|
| Dependency | GitHub App approval in partner orgs | Solutions | Fine-grained permissions doc; GHES install guide |
| Dependency | Atlassian Marketplace listing (Forge) | Integrations | Forge app review in week 9 |
| Risk | MDX round-trip fidelity in the editor (V1) | Editor team | Opaque MDX nodes plus a corpus fidelity suite |
| Risk | False positives from contextual mentions | Core | Precision eval, per-rule demotion, ignore pragmas (`<!-- docops-ignore drift/stale-reference -->`) |
| Open question | Price on seats, repositories or published pages? | PM | Willingness-to-pay study with design partners by week 8 |
| Open question | Should `drift/semantic` ever block? | PM, Eng | Decide after 3 months of precision data; default stays advisory |
| Open question | Jira DC: is the REST-only integration enough without a P2 plugin? | Integrations | Partner interviews; see [Jira design §10](06-jira-integration.md#10-jira-data-center-strategy) |
