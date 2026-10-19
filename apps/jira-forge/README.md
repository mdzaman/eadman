# EADMan for Jira Cloud (Forge app)

The Jira side of EADMan: every ticket shows whether its documentation exists, is in review, merged, published or stale, release managers see docs readiness per fix version, and tickets can be blocked from *Done* until docs are merged.

Design: [docs/06-jira-integration.md](../../docs/06-jira-integration.md) (the manifest in §3.1 is authoritative) and [ADR-0009](../../docs/adr/0009-jira-forge-app.md). API: [api/openapi.yaml](../../api/openapi.yaml).

This app is **not** part of the root npm workspaces. It is installed, type-checked and deployed with its own `package.json` and the Forge CLI. Only `src/view-model.ts`, `src/validation.ts` and `test/` are picked up by the repo's test runner and root `tsconfig.json`.

## What it does

| Module (manifest key) | Resource | What the user sees | EADMan API operation |
|---|---|---|---|
| `jira:issuePanel` (`docops-docs-panel`) | `src/frontend/issue-panel.tsx` | Status lozenge, reasons, linked pages (stale ones first) and pull requests, and the **Link documentation** action | `getTicketDocs`, `createLink` |
| `jira:issueContext` (`docops-docs-glance`) | `src/frontend/issue-context.tsx` | Compact status, one sentence of why, and how much is linked | `getTicketDocs` |
| `jira:projectPage` (`docops-readiness`) | `src/frontend/readiness.tsx` | Per fix version: `Ready 82% · Blockers 3 (Missing 2, Stale 1) · In review 4`, a table with blockers first, and **Create doc tasks for Missing (N)**. Only issues the user can see in Jira are counted and listed | `getReadiness`, `createDocTasks` |
| `jira:adminPage` (`docops-admin`, `useAsConfig`) | `src/frontend/admin.tsx` | Installation ID to register in EADMan, docs space and project settings, connection check | `listPages` (check only) |
| `jira:issueAction` (`docops-link-doc`) | `src/frontend/link-dialog.tsx` | Dialog from the issue's menu: search a EADMan page and link it | `listPages`, `createLink` |
| `jira:customField` (`docs-status`) | none | Read-only **Docs status** field, JQL-searchable; written by the EADMan `tracker-sync` worker | none (no code here) |
| `jira:workflowValidator` (`docs-merged-validator`) | none | Blocks a transition unless docs are merged or published, reading the `docops.docs` issue property (Jira expression) | none (no code here) |
| `trigger` (`docops-issue-events`) + `endpoint` | none | Issue created/updated/deleted and version released are forwarded to `/hooks/jira` with the Forge Invocation Token and an app system token | `receiveJiraWebhook` |

Status is always shown as text in a lozenge, never by color alone. The readiness table has a header row.

## Layout

```text
apps/jira-forge/
├── manifest.yml               # exactly docs/06 §3.1
├── package.json  tsconfig.json
├── src/
│   ├── index.ts               # Forge resolvers: getTicketDocs, getReadiness, createDocTasks, linkPage,
│   │                          #   searchPages, listFixVersions, getConfig, saveConfig, checkConnection
│   ├── contract.ts            # types shared by the resolvers and the UI (names, payloads, results)
│   ├── view-model.ts          # PURE: API payload -> panel / readiness view model, lozenges, guards (unit-tested)
│   ├── validation.ts          # PURE: input validation, trusted-vs-payload keys, JQL quoting (unit-tested)
│   └── frontend/              # UI Kit (@forge/react) modules + api.ts (typed invoke) + shared.tsx
└── test/                      # node:test, run by `npm test -- jira-forge` at the repo root
    ├── view-model.test.ts  validation.test.ts
    ├── resolvers.test.ts      # the real resolvers (src/index.ts) bundled with esbuild against in-memory Forge stubs
    └── support/forge-stubs.ts
```

All logic runs in EADMan. The Forge functions only validate input, take the issue or project from the Forge context, call EADMan through Forge Remote and return an `ApiResult` (`{ ok: true, data }` or `{ ok: false, error }`). They never throw to the UI.

## Authentication: the Forge Invocation Token

There is no API key in this app.

1. The UI calls a resolver (`invoke` from `@forge/bridge`).
2. The resolver calls `invokeRemote("docops", { path, ... })` from `@forge/api`. The `docops` remote in `manifest.yml` lists the `compute` operation and `permissions.external.fetch.backend`.
3. Forge signs the call and sends a **Forge Invocation Token (FIT)**, a short-lived JWT, as `Authorization: Bearer`.
4. EADMan verifies it against Atlassian's JWKS (`https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json`): `iss = forge/invocation-token`, `aud =` this app's ARI, `exp`, and a `jti` replay cache. `app.installationId` in the token resolves the **tenant** through `tenant_routes(kind = 'forge_installation')`. See [docs/04-api-design.md §2](../../docs/04-api-design.md) and threat T04 in [docs/08](../../docs/08-security-compliance.md).
5. Triggers go to the `docops-events` endpoint (`/hooks/jira`) with the FIT and an `x-forge-oauth-system` app system token (`endpoint.auth.appSystemToken`). The `tracker-sync` worker uses that token to write the `docops.docs` issue property, remote links and *Docs status* values back to Jira.

Two things follow:

- EADMan must know **this app's ARI** (`app.id` in `manifest.yml`, assigned by `forge register`) as the expected `aud`, and the **installation ID** of each site (shown on the admin page) must be registered to a tenant.
- `remotes[].baseUrl` is fixed at deploy time, with one URL per data-residency region (`default` and `EU`). Changing a remote URL or the egress permissions is a major version upgrade for installed sites (ADR-0009), so a self-hosted or private deployment edits `baseUrl` in its own copy of the manifest and deploys it as its own Forge app.

### Authorization inside the app

Every resolver is reachable from every module's UI, and anything the browser sends (`payload`) is user input. EADMan is called as the app, not as the user, so it can see more than the user can. The resolvers therefore apply the user's own Jira rights before they read or write anything:

- **Which issue or project?** It is read from the **Forge resolver context**, which the platform sets, so it is the object the user is looking at and needs no further check (`readIssueKeyWithSource` and `readProjectKeyWithSource` in `src/validation.ts` return `{ key, trusted }`). The payload is only a fallback. When a key comes from the payload, `getTicketDocs` first reads the issue from Jira *as the user* (`GET /rest/api/3/issue/{key}?fields=summary`; 401, 403 and 404 mean the user cannot see it, including through an issue security level) and `getReadiness` checks the user's `BROWSE_PROJECTS` permission on the project. Only then is EADMan called. A forged payload key never overrides the context key.
- **Readiness rows are cut down to what the user can see.** EADMan lists every issue of a fix version that it mirrors, including issues that an issue security level hides from this user. After EADMan answers, `getReadiness` searches Jira *as the user* (`POST /rest/api/3/search/jql` with `fields: ["key"]`, 100 per page, following `nextPageToken`) for `project = "P" AND fixVersion = "V"`, drops every row whose key the search did not return, and **recomputes the summary** (total, counts per status, ready percentage, blockers, in review, `ready`) from the rows that remain, so a hidden issue shows up neither as a row nor in a number. If every row is visible, EADMan's own summary is passed through untouched. The project key and version name go into the JQL as quoted strings (`jqlQuote` escapes `\` and `"`), so a version name cannot change the query.
- **The readiness search fails closed too.** A search that fails, or answers with something other than an issue list with keys, is reported as "could not be verified" (HTTP 502, code `forge_jira_error`). A fix version with more issues than the search reads (20 pages of 100) is reported as "too many issues to check" (HTTP 422, code `forge_too_many_issues`). In both cases no readiness data is shown.
- **Writes** check the calling user's Jira permission with `GET /rest/api/3/mypermissions` as that user: creating doc tasks needs `CREATE_ISSUES` on the project, linking a page needs `LINK_ISSUES` on the issue. Doc tasks are created by EADMan as the app, under whichever tickets of the fix version the request names, so `createDocTasks` also requires every ticket to belong to the project and to be in the user's own search for the fix version (the search above). A ticket the user cannot see, or that is not in the version, refuses the whole request with the same answer, which does not name the ticket.
- **Settings** (`getConfig`, `saveConfig`, `checkConnection`) need the `ADMINISTER` permission, checked in the resolver, not in the UI.
- Every check **fails closed**. A lookup Jira cannot answer is reported as "could not be verified" (HTTP 502, code `forge_jira_error`), kept apart from "not allowed" (403, `forge_forbidden`), and EADMan is not called in either case.
- Keys are matched against the ticket-key and project-key patterns before they go into a URL path or query, and idempotency keys (one per click) are sent to EADMan for every `POST`.
- Settings (the docs space and the project list) are the only thing stored in Forge hosted storage (`@forge/kvs`, scope `storage:app`, per installation). No page content and no account IDs are stored.

All of these Jira calls use the classic scope `read:jira-work` that `manifest.yml` already declares (see the table below).

## Prerequisites

- Node.js 22 or 24 and the Forge CLI: `npm install -g @forge/cli`.
- An Atlassian account with a development site, and `forge login`.
- A EADMan API reachable at the `remotes` base URLs in `manifest.yml`. The placeholder hosts (`*.docops.example`), the `icon` URL and the `app.id` ARI are replaced for a real deployment.

## Deploy

```bash
cd apps/jira-forge
npm install                       # installs this app's own dependencies; it is not a root workspace

forge login
forge register                    # creates the app and writes its ARI into manifest.yml (app.id)
# edit manifest.yml: remotes[0].baseUrl (your EADMan cell URLs) and the panel icon URL

npm run typecheck                 # tsc --noEmit, strict
forge lint
forge deploy -e development
forge install --site acme.atlassian.net --product jira   # add -e <environment> for staging or production
```

After the first install:

1. Give EADMan the app ARI and register the installation: open **Jira settings > Apps > Manage apps > EADMan > Configure**, copy the **Installation ID**, and register it for your tenant in EADMan.
2. On the same page, enter the **documentation space ID** (UUID from EADMan), optionally restrict **Projects**, save, and use **Check connection**.
3. Create the Jira fields **Docs required** (select: Yes, No) and **Docs not required reason** (multi-line text), and give the field ID to EADMan as `integrations.jira.docsRequired.field` in `docops.yaml`.
4. Add **Docs merged (EADMan)** to the *Done* transition of the workflows that need it (project settings > Workflows > transition > Validators).
5. After any change to scopes or egress, deploy and then `forge install --upgrade --site acme.atlassian.net --product jira`.

Secrets: none are required. If you add one, store it encrypted, never in the manifest or source:

```bash
forge variables set --encrypt NAME value
```

Day to day: `forge tunnel` for live development against a development site, `forge logs` for resolver logs (they log status codes and trace IDs, never ticket content).

## Tests and checks

From the repo root:

```bash
npm test -- jira-forge            # view-model, validation and resolver tests (no Forge packages needed)
npm run typecheck                 # includes src/view-model.ts, src/validation.ts and test/*.ts
```

`test/resolvers.test.ts` runs the real `src/index.ts`. It bundles it with esbuild, which the repo root already has, and points `@forge/api`, `@forge/kvs` and `@forge/resolver` at `test/support/forge-stubs.ts`. It covers which key is trusted, when a Jira visibility or permission check runs, that EADMan is never called after a denial, the readiness visibility filter (rows dropped, totals recomputed, nothing leaked, pagination, the page cap, failures and odd answers, JQL quoting), the same visibility rule for doc tasks, and the administrator-only settings. The stubs are an assumption about the Forge API, which the app's own typecheck verifies against the real typings.

Inside `apps/jira-forge` (after `npm install`), `npm run typecheck` type-checks everything under `src`, including the resolvers and the UI. This matters because **`forge deploy` fails on any TypeScript error** (the Forge bundler compiles with `ts-loader`). The same compile also type-checks `src/index.ts` when it builds the UI bundles, so keep the whole of `src` error-free. `test/` is excluded from the app's `tsconfig.json` for that reason.

Conventions:

- `view-model.ts` and `validation.ts` import nothing, are erasable TypeScript only, and never mutate their input. The tests import them with `.ts` extensions.
- Files that the Forge bundler compiles (`index.ts`, `contract.ts`, `frontend/*`) import siblings **without** extensions; webpack resolves them (`resolve.extensions` in the bundler config). A `.ts` specifier fails the build with TS5097; enabling `allowImportingTsExtensions` requires `noEmit`, which leaves `ts-loader` with nothing to emit; and `rewriteRelativeImportExtensions` produces `./x.js`, which webpack cannot resolve. All three were tried against the bundler's configuration.
- `react` is pinned to 18.x because `@forge/react@12` depends on React 18.

### Forge APIs used and where each was verified

| API | Verified against |
|---|---|
| `Resolver`, `define`, `getDefinitions`, `Handlers<>` | `@forge/resolver@2.0.1` typings; [Forge resolver reference](https://developer.atlassian.com/platform/forge/runtime-reference/forge-resolver/) |
| `invokeRemote(remoteKey, { path, method, headers, body })` | `@forge/api@8.3.0` `out/api/endpoint.d.ts`; [invokeRemote reference](https://developer.atlassian.com/platform/forge/runtime-reference/invoke-remote-api/) |
| `asUser().requestJira(route\`...\`)`, `route` | `@forge/api@8.3.0` typings |
| `getAppContext().installationAri.installationId` | `@forge/api@8.3.0` typings; [app context API](https://developer.atlassian.com/platform/forge/runtime-reference/app-context-api/) |
| `kvs.get`, `kvs.set` | `@forge/kvs@2.1.0` typings; [Key-Value Store](https://developer.atlassian.com/platform/forge/storage-reference/kvs/) |
| `invoke`, `makeInvoke`, `view.close()` | `@forge/bridge@7.2.0` typings; [view API](https://developer.atlassian.com/platform/forge/apis-reference/ui-api-bridge/view/) |
| `ForgeReconciler`, `useProductContext`, `useForm`, UI Kit components and props | `@forge/react@12.3.1` and `@atlaskit/forge-react-types@2.10.5` typings; [UI Kit components](https://developer.atlassian.com/platform/forge/ui-kit/components/) |
| Module properties and `extension` context (`issue.key`, `project.key`) | [jira:issuePanel](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-issue-panel/), [jira:projectPage](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-project-page/), [jira:adminPage](https://developer.atlassian.com/platform/forge/manifest-reference/modules/jira-admin-page/) |

### Jira REST calls made as the user, and where each was verified

`manifest.yml` declares the classic scope `read:jira-work`, which covers all of them. Atlassian's [Jira scopes page](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/) describes it as reading project and issue data and searching for issues.

| Call | Used for | Verified against |
|---|---|---|
| `GET /rest/api/3/mypermissions` | The `ADMINISTER`, `BROWSE_PROJECTS`, `CREATE_ISSUES` and `LINK_ISSUES` checks | Atlassian's notice [Updated OAuth 2.0 scope requirements for 6 Jira Cloud REST endpoints](https://community.developer.atlassian.com/t/updated-oauth-2-0-scope-requirements-for-6-jira-cloud-rest-endpoints/75109), posted 2023-11-30 and effective 2024-02-15: *Get my permissions* needs the classic scope `read:jira-work` or the granular scope `read:permission:jira` |
| `GET /rest/api/3/issue/{key}?fields=summary` | Whether the user can see an issue whose key came from the payload | Jira Cloud OpenAPI description ([`swagger-v3.v3.json`](https://dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json), *Get issue*): needs Browse projects and, where issue-level security is configured, permission to view the issue; 404 when the issue is not found or the user may not view it; classic scope `read:jira-work` |
| `POST /rest/api/3/search/jql` | Which issues of a fix version the user can see (readiness rows, doc-task requests) | Same description (*Search for issues using JQL enhanced search (POST)*): issues are included where the user has Browse projects and, with issue-level security, permission to view them; body `jql` (a bounded query), `fields`, `maxResults` (a per-page maximum, default 50) and `nextPageToken`; response `issues`, `isLast` and `nextPageToken` (null on the last page); classic scope `read:jira-work`. Only the issue ID is returned unless `fields` asks for more, and `key` is requested explicitly ([RFC-61](https://community.developer.atlassian.com/t/rfc-61-evolving-search-capabilities-addressing-scalability-with-a-new-enhanced-search-api/83027)) |
| `GET /rest/api/3/project/{key}/versions` | The fix-version list | Same description (*Get project versions*): 404 when the project is not found or the user may not view it; classic scope `read:jira-work` |

`manifest.yml` validates with `@forge/manifest@13.7.0` (the manifest validator used by the Forge CLI). The function bundle and the five UI bundles compile with webpack 5.109.2, `ts-loader` 9.5.2 and TypeScript 5.9.2, using rules mirrored from `@forge/bundler@7.3.0`. None of this has run on a live Jira site.

## Not included, and things to confirm on a development site

- **`fields: ["key"]` on the visibility search.** The enhanced search returns only issue IDs unless `fields` asks for more, and the app asks for `key` as RFC-61 shows. This was checked against Atlassian's published descriptions, not on a live site. If your site answers without keys, the readiness page and doc-task creation report "could not be verified" and show nothing (they fail closed), which is the signal to look at `forge logs` (`issue search returned an issue without a key`).
- **Strict-mode function validator** (design §7): the shipped manifest uses the Jira-expression validator. ADR-0009 notes that expressions over `issue.properties` inside Forge workflow validators need confirming on a development site; if they do not evaluate, add a function-based `jira:workflowValidator` that calls `getTicketDocs` and returns `{ result, errorMessage }`.
- **Export CSV** and **Open traceability report** from the §9 mock-up are not implemented (they need a download mechanism and the EADMan web URL, which this version does not have).
- **Creating the Jira fields from the admin page** (design §4.3) needs the `manage:jira-configuration` scope, which §3.1 does not request. The admin page documents the manual setup instead.
- **External links** (documentation site, pull requests) open through Atlassian's external-link handling. If your site blocks them, check Atlassian's link-egress setting for Forge apps.
- Closing the issue-action dialog uses `view.close()`; confirm it on your site.

## Jira Data Center (REST-only alternative)

There is no Forge on Data Center, and ADR-0009 decides against building a P2 plugin for a product line that reaches end of life on 2029-03-28. Data Center uses the same EADMan API without an app:

| Capability | Data Center |
|---|---|
| Issue panel | Remote links plus the `docops.docs` issue property, visible in the standard issue view, and a EADMan web-app deep link |
| Docs status field | A standard text field that EADMan updates through REST (the admin creates it at setup) |
| Validator | The ScriptRunner validator below, or your own scripted validator calling `GET /v1/tickets/{key}/docs` |
| Events | Admin webhooks with a secret: `X-Hub-Signature: sha256=...`, de-duplicated by `X-Atlassian-Webhook-Identifier` |
| Auth to Jira | OAuth 2.0 (incoming link) or a personal access token for a service user |
| Network | EADMan self-hosted inside the network, or an allow-listed egress from the SaaS cell |

### ScriptRunner validator

Add it as a **Script Validator** (Custom script validator) on the *Done* transition: **Workflow > transition > Validators > Add validator > ScriptRunner**. It calls `GET /v1/tickets/{key}/docs` and blocks the transition unless `docsStatus` is `merged` or `published`. It also lets `not_required` through, matching the Cloud expression (`required != 'yes' || status in ['merged', 'published']`); without that, a ticket whose docs are waived could never be closed.

Configure the EADMan URL with the JVM property `-Ddocops.url=https://docops.internal.example` and a EADMan API token with read scopes (`docs:read`, `readiness:read`) in the environment variable `DOCOPS_API_TOKEN` of the Jira process. Never paste the token into the script.

```groovy
import com.opensymphony.workflow.InvalidInputException
import groovy.json.JsonSlurper
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

// ---- configuration -------------------------------------------------------------------------
final String baseUrl = (System.getProperty('docops.url') ?: 'https://docops.internal.example').replaceAll('/+$', '')
final String token = System.getenv('DOCOPS_API_TOKEN')
final Set<String> allowed = ['merged', 'published', 'not_required'] as Set
final boolean failClosed = true   // true: block the transition when EADMan cannot be reached

// `issue` is bound by ScriptRunner to the issue being transitioned.
final String key = issue.key

if (!token) {
    throw new InvalidInputException('EADMan is not configured: set DOCOPS_API_TOKEN for the Jira process.')
}

String docsStatus = null
String problem = null
try {
    HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build()
    HttpRequest request = HttpRequest.newBuilder(URI.create("${baseUrl}/v1/tickets/${URLEncoder.encode(key, 'UTF-8')}/docs?tracker=jira_dc"))
            .timeout(Duration.ofSeconds(5))
            .header('Authorization', "Bearer ${token}".toString())
            .header('Accept', 'application/json')
            .GET()
            .build()
    HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString())
    if (response.statusCode() == 200) {
        docsStatus = new JsonSlurper().parseText(response.body()).docsStatus as String
    } else {
        problem = "EADMan answered HTTP ${response.statusCode()}"
    }
} catch (Exception e) {
    problem = "EADMan is unreachable (${e.class.simpleName})"
}

if (docsStatus == null) {
    log.warn("EADMan docs check for ${key} failed: ${problem}")
    if (failClosed) {
        throw new InvalidInputException("The docs status of ${key} could not be verified (${problem}). Try again, or ask a Jira administrator.")
    }
    return
}

if (!allowed.contains(docsStatus)) {
    throw new InvalidInputException("Docs required: the documentation for ${key} is '${docsStatus}'. Link a merged doc change, or set Docs required = No with a reason.")
}
```

This snippet has not been run against a Data Center instance: try it on a staging Jira first. It uses `java.net.http`, so the Jira JVM must run Java 11 or later.
