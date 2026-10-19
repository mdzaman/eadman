/**
 * Docs status glance in the issue context area (module jira:issueContext, resource `issue-context`):
 * the status as text, one sentence of why, and how much is linked. Read-only; actions live in the
 * issue panel. Data: resolver getTicketDocs -> GET /v1/tickets/{key}/docs.
 */
import React from "react";
import ForgeReconciler, { Inline, Stack, Text, useProductContext } from "@forge/react";

import { readIssueKey } from "../validation";
import { toPanelViewModel } from "../view-model";
import { api } from "./api";
import { ErrorNotice, Loading, StatusBadge, useLoader } from "./shared";

function DocsGlance({ issueKey }: { issueKey: string | undefined }) {
  const { state, reload } = useLoader(() => api.getTicketDocs(issueKey), [issueKey]);

  if (state.status === "idle" || state.status === "loading") return <Loading label="Loading documentation status" />;
  if (state.status === "error") return <ErrorNotice error={state.error} onRetry={reload} />;

  const view = toPanelViewModel(state.data);
  return (
    <Stack space="space.100">
      <Inline space="space.100" alignBlock="center" shouldWrap>
        <StatusBadge lozenge={view.lozenge} />
        <Text size="small">Docs required: {view.docsRequiredLabel}</Text>
      </Inline>
      <Text>{view.description}</Text>
      <Text size="small">{view.linkedSummary}</Text>
    </Stack>
  );
}

function App() {
  const context = useProductContext();
  if (context === undefined) return <Loading label="Loading" />;
  return <DocsGlance issueKey={readIssueKey(context, undefined)} />;
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
