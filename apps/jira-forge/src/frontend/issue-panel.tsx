/**
 * Docs panel on the issue view (module jira:issuePanel, resource `issue-panel`):
 * status lozenge, linked pages and pull requests, and the "Link documentation" action.
 * Data: resolver getTicketDocs -> GET /v1/tickets/{key}/docs.
 */
import React, { useState } from "react";
import ForgeReconciler, { Button, Inline, Link, LinkButton, List, ListItem, Stack, Text, useProductContext } from "@forge/react";

import { readIssueKey } from "../validation";
import { toPanelViewModel } from "../view-model";
import type { PanelAction, PanelPage, PanelPullRequest } from "../view-model";
import { api } from "./api";
import { ErrorNotice, LinkDocsForm, Loading, Section, StatusBadge, useLoader } from "./shared";

function PageList({ pages }: { pages: PanelPage[] }) {
  return (
    <Section title="Pages">
      <Stack space="space.075">
        {pages.map((page) => (
          <Inline key={page.key} space="space.100" alignBlock="center" shouldWrap>
            {page.url !== undefined ? (
              <Link href={page.url} openNewTab>
                {page.title}
              </Link>
            ) : (
              <Text>{page.title}</Text>
            )}
            {page.staleLozenge !== null ? <StatusBadge lozenge={page.staleLozenge} /> : null}
            {page.url === undefined ? <Text size="small">Not published</Text> : null}
          </Inline>
        ))}
      </Stack>
    </Section>
  );
}

function PullRequestList({ pullRequests }: { pullRequests: PanelPullRequest[] }) {
  return (
    <Section title="Pull requests">
      <Stack space="space.075">
        {pullRequests.map((pr) => (
          <Inline key={pr.key} space="space.100" alignBlock="center" shouldWrap>
            {pr.url !== undefined ? (
              <Link href={pr.url} openNewTab>
                {pr.label}
              </Link>
            ) : (
              <Text>{pr.label}</Text>
            )}
            <StatusBadge lozenge={pr.lozenge} />
            {pr.touchesDocs ? <Text size="small">Changes docs</Text> : null}
            {pr.title !== "" ? <Text size="small">{pr.title}</Text> : null}
          </Inline>
        ))}
      </Stack>
    </Section>
  );
}

/** The primary action leads; "Link documentation" is always available as a quieter option. */
function Actions({ action, onLink }: { action: PanelAction | null; onLink: () => void }) {
  const linkIsPrimary = action?.kind === "link_docs";
  return (
    <Inline space="space.100" shouldWrap>
      {action?.kind === "open_url" ? (
        <LinkButton appearance="primary" href={action.href} target="_blank">
          {action.label}
        </LinkButton>
      ) : null}
      <Button appearance={linkIsPrimary ? "primary" : "subtle"} onClick={onLink}>
        {action?.kind === "link_docs" ? action.label : "Link documentation"}
      </Button>
    </Inline>
  );
}

function DocsPanel({ issueKey }: { issueKey: string | undefined }) {
  const { state, reload } = useLoader(() => api.getTicketDocs(issueKey), [issueKey]);
  const [linking, setLinking] = useState(false);

  if (state.status === "idle" || state.status === "loading") return <Loading label="Loading documentation status" />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;

  const view = toPanelViewModel(state.data);
  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <StatusBadge lozenge={view.lozenge} />
        <Text>Docs required: {view.docsRequiredLabel}</Text>
      </Inline>

      {view.reasons.length === 0 ? (
        <Text>{view.description}</Text>
      ) : (
        <List type="unordered">
          {view.reasons.map((reason) => (
            <ListItem key={reason}>{reason}</ListItem>
          ))}
        </List>
      )}

      {view.pages.length > 0 ? <PageList pages={view.pages} /> : null}
      {view.pullRequests.length > 0 ? <PullRequestList pullRequests={view.pullRequests} /> : null}

      <Actions action={view.primaryAction} onLink={() => setLinking(true)} />
      {linking ? (
        <Section title="Link documentation">
          <LinkDocsForm
            issueKey={issueKey}
            onCancel={() => setLinking(false)}
            onLinked={() => {
              setLinking(false);
              reload();
            }}
          />
        </Section>
      ) : null}
    </Stack>
  );
}

function App() {
  // `useProductContext` is undefined until the context has loaded.
  const context = useProductContext();
  if (context === undefined) return <Loading label="Loading" />;
  return <DocsPanel issueKey={readIssueKey(context, undefined)} />;
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
