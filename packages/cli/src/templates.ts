/** Page templates for `docops new` (docs/01-product-requirements.md US-AUTH-04). */
export const PAGE_TEMPLATES: Record<string, { type: string; body: (title: string) => string }> = {
  guide: {
    type: "guide",
    body: (t) => `# ${t}\n\nWhat this guide helps you do, and who it is for.\n\n## Before you begin\n\n- Prerequisite\n\n## Steps\n\n1. First step.\n2. Second step.\n\n## Next steps\n\n- Related guide\n`,
  },
  "how-to": {
    type: "how_to",
    body: (t) => `# ${t}\n\nOne sentence on the outcome.\n\n## Steps\n\n1. Step one.\n2. Step two.\n\n## Verify\n\nHow to confirm it worked.\n`,
  },
  tutorial: {
    type: "tutorial",
    body: (t) => `# ${t}\n\nWhat you will build and learn.\n\n## Set up\n\n## Build it\n\n## What you learned\n`,
  },
  concept: { type: "concept", body: (t) => `# ${t}\n\nExplain the idea, why it matters, and how it relates to other concepts.\n` },
  "api-guide": {
    type: "guide",
    body: (t) => `# ${t}\n\nWhich operations this guide covers (list them under \`entities:\` in the frontmatter).\n\n## Authenticate\n\n## Make the request\n\n\`\`\`bash\ncurl -X POST {{ apiBaseUrl }}/v1/... \\\n  -H "Authorization: Bearer $API_KEY"\n\`\`\`\n\n## Handle errors\n`,
  },
  runbook: {
    type: "runbook",
    body: (t) =>
      `# ${t}\n\n**Alert:** name of the alert that links here.\n**Severity:** SEV-2\n**Owner:** team\n\n## Symptoms\n\n## Diagnose\n\n1. Check dashboards.\n\n## Mitigate\n\n1. Safe, reversible action first.\n\n## Escalate\n\nWho to page and when.\n\n## Follow-up\n\nLink the postmortem.\n`,
  },
  adr: {
    type: "adr",
    body: (t) => `# ${t}\n\n## Context\n\n## Decision\n\n## Options considered\n\n| Option | Pros | Cons |\n|---|---|---|\n| A | | |\n| B | | |\n\n## Consequences\n`,
  },
  postmortem: {
    type: "postmortem",
    body: (t) => `# ${t}\n\n## Summary\n\n## Impact\n\n## Timeline (UTC)\n\n| Time | Event |\n|---|---|\n\n## Root cause\n\n## What went well / what did not\n\n## Action items\n\n| Action | Owner | Ticket |\n|---|---|---|\n`,
  },
  onboarding: { type: "onboarding", body: (t) => `# ${t}\n\n## Day 1\n\n## Week 1\n\n## Who to ask\n` },
  "release-notes": {
    type: "release_notes",
    body: (t) => `# ${t}\n\n## Breaking changes\n\n## New features\n\n## Fixes\n\n## Deprecations\n`,
  },
};

export function renderTemplate(name: string, title: string, today: string, extra: { owners?: string[]; extraFrontmatter?: string } = {}): string {
  const template = PAGE_TEMPLATES[name];
  if (!template) throw new Error(`unknown template ${name}`);
  const fm = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `type: ${template.type}`,
    `owners: [${(extra.owners ?? []).map((o) => JSON.stringify(o)).join(", ")}]`,
    `reviewed: ${today}`,
    ...(name === "adr" ? ["status: proposed"] : []),
    ...(extra.extraFrontmatter ? [extra.extraFrontmatter] : []),
    "---",
    "",
  ].join("\n");
  return `${fm}${template.body(title)}`;
}

export function configTemplate(projectId: string, projectName: string, sources: Array<{ id: string; path: string }>): string {
  return `# yaml-language-server: $schema=https://schemas.docops.example/docops.schema.json
version: 1

project:
  id: ${projectId}
  name: ${JSON.stringify(projectName)}

docs:
  root: docs
${sources.length ? `\nsources:\n${sources.map((s) => `  - id: ${s.id}\n    type: openapi\n    path: ${s.path}`).join("\n")}\n` : ""}
checks:
  failOn: error
  links: { level: block }
  coverage: { level: warn, minimum: 0, kinds: [api.operation] }
  schemaChange: { level: block }
  drift: { level: block, changedEntityLevel: warn }
  frontmatter: { level: block, required: [title] }
`;
}

export const GITHUB_WORKFLOW = `name: docs
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
  checks: write
  id-token: write
jobs:
  check:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: docops/action@v1
        with:
          command: check
          base: origin/\${{ github.base_ref }}
  publish:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: docops/action@v1
        with:
          command: publish
          environment: dev
`;

export const GITLAB_PIPELINE = `docs:check:
  image: node:24-alpine
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - apk add --no-cache git && npm install --global @docops/cli@1
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - docops check --base "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" --report codequality=gl-code-quality-report.json
  artifacts:
    when: always
    reports:
      codequality: gl-code-quality-report.json
`;
