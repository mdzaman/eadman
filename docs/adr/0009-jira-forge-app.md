---
title: "ADR-0009: Forge for Jira Cloud; REST-only integration for Data Center"
type: adr
status: accepted
date: 2026-10-18
owners: ["@docops/integrations"]
---

# ADR-0009: Forge for Jira Cloud; REST-only integration for Data Center

## Context

DocOps needs four things inside Jira: an issue panel, a read-only JQL-searchable field, a release-readiness page and a workflow validator. As verified in October 2026:

- **Atlassian Connect is ending.** New Connect apps have not been accepted on the Marketplace since 2025-09-17. Apps with a Connect descriptor lost the ability to ship updates in March 2026. End of support is **2027-01-31**.
- **Forge** supports everything we need: `jira:issuePanel`, `jira:issueContext`, `jira:projectPage`, `jira:adminPage`, `jira:issueAction`, `jira:customField` (read-only, app-written values), `jira:workflowValidator` (expression- or function-based), product-event triggers, and **Forge Remote** to call our backend with a signed Forge Invocation Token (FIT). The runtime is `nodejs24.x`, and Forge supports data-residency pinning with region-specific remote base URLs.
- **Jira Data Center:** end of sale to new customers was 2026-03-30, and end of life is **2029-03-28**.

## Decision

1. **Jira Cloud:** a Forge app (UI Kit, `render: native`) with Forge Remote to the DocOps API. The function and remote handlers run on `nodejs24.x`. Remotes have per-region base URLs, so cell residency matches the tenant's.
2. **System of record in Jira:** docs status and links are written to Jira as an issue entity property (`docops.docs`), remote issue links (upserted by `globalId`) and the read-only custom field *Docs status*. Jira users see the truth even if DocOps is unavailable.
3. **Jira Data Center:** a REST-only integration. Webhooks are verified with the `X-Hub-Signature` HMAC, and links and status go to issue properties and remote links. Enforcement runs through the customer's own workflow validator (ScriptRunner snippet provided) or Automation for Jira. We do **not** build a P2 plugin, given the 2029 end of life.
4. **No Connect** modules anywhere, because a Forge manifest with Connect modules still counts as a Connect app.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **Forge + Forge Remote** | Supported long-term; Atlassian-hosted UI; FIT auth; residency support; Marketplace-eligible | Forge runtime limits (we keep logic in our backend); UI Kit constraints |
| Connect app | Familiar | Can't be listed and loses support in 2027 |
| OAuth 2.0 (3LO) integration with no Jira UI | Simple | No issue panel, validator or project page; poor UX |
| P2 plugin for DC | Full DC UI parity | Java/OSGi investment for a product line reaching end of life in 2029 |

## Consequences

- Forge Remote endpoint changes trigger a major version upgrade on deploy, so endpoint definitions are kept stable and versioned behind one route per concern.
- The expression-based validator reads `issue.properties['docops.docs']`. The Jira expression type reference documents `Issue.properties`, but its use inside Forge workflow validators needs confirmation on a development site, so a function-based validator (strict mode) is the fallback.
- `app.installationId` from the FIT maps to the tenant through `tenant_routes(kind = 'forge_installation')`.
