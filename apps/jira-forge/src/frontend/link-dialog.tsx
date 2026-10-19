/**
 * "Link documentation" issue action (module jira:issueAction, resource `link-dialog`).
 * Jira opens this module in a dialog from the issue's ... menu. Search a DocOps page, link it
 * (operation createLink), then close. The same form is embedded in the issue panel.
 */
import React, { useState } from "react";
import ForgeReconciler, { Button, Stack, Text, useProductContext } from "@forge/react";
import { view } from "@forge/bridge";

import { readIssueKey } from "../validation";
import { Loading, LinkDocsForm } from "./shared";

function LinkDialog({ issueKey }: { issueKey: string | undefined }) {
  const [linked, setLinked] = useState(false);

  if (linked) {
    return (
      <Stack space="space.200">
        <Text>The page is linked to {issueKey ?? "this issue"}. The Docs status updates in a few seconds.</Text>
        {/* view.close() closes the dialog that Jira opened for this issue action. */}
        <Button appearance="primary" onClick={() => void view.close()}>
          Close
        </Button>
      </Stack>
    );
  }
  return <LinkDocsForm issueKey={issueKey} onLinked={() => setLinked(true)} onCancel={() => void view.close()} />;
}

function App() {
  const context = useProductContext();
  if (context === undefined) return <Loading label="Loading" />;
  return <LinkDialog issueKey={readIssueKey(context, undefined)} />;
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
