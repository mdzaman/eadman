/**
 * Admin page (module jira:adminPage with `useAsConfig: true`: the Configure button of the app in
 * Manage apps). Three jobs, all kept small:
 *   1. connect: show the installation ID that DocOps maps to a tenant, and check the connection;
 *   2. choose the DocOps space that "Link documentation" searches, and the projects the app shows in;
 *   3. explain the Jira fields DocOps reads (their mapping lives in docops.yaml, not here).
 * Settings live in Forge hosted storage (resolvers getConfig / saveConfig); saving is allowed for
 * Jira administrators only, and the resolver enforces that.
 */
import React, { useState } from "react";
import ForgeReconciler, { Code, Form, FormFooter, Button, Heading, HelperMessage, Label, List, ListItem, LoadingButton, SectionMessage, Stack, Text, Textfield, useForm } from "@forge/react";

import type { AdminConfig, AdminSettings, ConnectionStatus, InstallationInfo } from "../contract";
import { parseProjectList } from "../validation";
import type { ApiError } from "../view-model";
import { api } from "./api";
import { ErrorNotice, Loading, Section, useLoader } from "./shared";
import type { LoadState } from "./shared";

function Installation({ installation }: { installation: InstallationInfo }) {
  return (
    <Section title="Connect this Jira site to DocOps">
      <Text>
        Register this installation in DocOps (Admin, Integrations, Jira Cloud) so that calls from this site are mapped to your tenant. No API key is involved: Forge signs every call to DocOps with an
        invocation token.
      </Text>
      <Text weight="semibold">Installation ID</Text>
      <Code>{installation.installationId === "" ? "unavailable" : installation.installationId}</Code>
      <Text weight="semibold">Site ID</Text>
      <Code>{installation.cloudId ?? "unavailable"}</Code>
    </Section>
  );
}

function ConnectionCheck() {
  const [state, setState] = useState<LoadState<ConnectionStatus>>({ status: "idle" });
  const check = async () => {
    setState({ status: "loading" });
    const result = await api.checkConnection();
    setState(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
  };
  return (
    <Stack space="space.100">
      <LoadingButton isLoading={state.status === "loading"} onClick={check}>
        Check connection
      </LoadingButton>
      {state.status === "ready" ? (
        <SectionMessage appearance="success" title="Connected">
          <Text>DocOps answered for this site, and the documentation space {state.data.spaceId} is reachable.</Text>
        </SectionMessage>
      ) : null}
      {state.status === "error" ? <ErrorNotice error={state.error} /> : null}
    </Stack>
  );
}

type SaveNotice = { kind: "saved" } | { kind: "invalid"; message: string } | { kind: "error"; error: ApiError };

function SettingsForm({ initial }: { initial: AdminConfig }) {
  const { register, handleSubmit, getFieldId } = useForm<{ spaceId: string; projects: string }>({
    defaultValues: { spaceId: initial.spaceId ?? "", projects: initial.projects.join(", ") },
  });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<SaveNotice | undefined>(undefined);

  const save = async (values: { spaceId: string; projects: string }) => {
    setNotice(undefined);
    const parsed = parseProjectList(values.projects);
    if (parsed.invalid.length > 0) {
      setNotice({ kind: "invalid", message: `These are not valid Jira project keys: ${parsed.invalid.join(", ")}.` });
      return;
    }
    setSaving(true);
    const result = await api.saveConfig({ spaceId: values.spaceId, projects: parsed.projects });
    setSaving(false);
    setNotice(result.ok ? { kind: "saved" } : { kind: "error", error: result.error });
  };

  return (
    <Section title="Settings">
      <Form onSubmit={handleSubmit(save)}>
        <Label labelFor={getFieldId("spaceId")}>Documentation space ID</Label>
        <Textfield {...register("spaceId", { maxLength: 36 })} />
        <HelperMessage>The DocOps space that "Link documentation" searches. Copy its ID (a UUID) from the space settings in DocOps.</HelperMessage>

        <Label labelFor={getFieldId("projects")}>Projects</Label>
        <Textfield {...register("projects", { maxLength: 2000 })} />
        <HelperMessage>
          Jira project keys, separated by commas (for example PAY, SEC), where the Docs panel and readiness page are shown. Leave empty for all projects. Which projects DocOps tracks is set by
          integrations.jira.projects in docops.yaml.
        </HelperMessage>

        <FormFooter align="start">
          <Button type="submit" appearance="primary" isDisabled={saving}>
            {saving ? "Saving" : "Save settings"}
          </Button>
        </FormFooter>
      </Form>
      {notice?.kind === "saved" ? (
        <SectionMessage appearance="success" title="Settings saved">
          <Text>Changes apply to the next panel or page that loads.</Text>
        </SectionMessage>
      ) : null}
      {notice?.kind === "invalid" ? (
        <SectionMessage appearance="error" title="Check the project list">
          <Text>{notice.message}</Text>
        </SectionMessage>
      ) : null}
      {notice?.kind === "error" ? <ErrorNotice error={notice.error} /> : null}
    </Section>
  );
}

function FieldGuide() {
  return (
    <Section title="Jira fields DocOps reads">
      <Text>
        The Docs status field is created by this app. Create these two once in Jira settings, Issues, Custom fields, then give the "Docs required" field ID to DocOps as
        integrations.jira.docsRequired.field in docops.yaml.
      </Text>
      <List type="unordered">
        <ListItem>Docs required: a select list with the options Yes and No.</ListItem>
        <ListItem>Docs not required reason: a multi-line text field. Add it to the Done screen and require a value when Docs required is No.</ListItem>
      </List>
    </Section>
  );
}

function Settings({ settings }: { settings: AdminSettings }) {
  return (
    <Stack space="space.300">
      <Installation installation={settings.installation} />
      <SettingsForm initial={settings.config} />
      <ConnectionCheck />
      <FieldGuide />
    </Stack>
  );
}

function App() {
  const { state, reload } = useLoader(() => api.getConfig(), []);
  return (
    <Stack space="space.300">
      <Heading size="large" as="h2">
        DocOps for Jira
      </Heading>
      {state.status === "idle" || state.status === "loading" ? <Loading label="Loading settings" /> : null}
      {state.status === "error" ? <ErrorNotice error={state.error} onRetry={reload} /> : null}
      {state.status === "ready" ? <Settings settings={state.data} /> : null}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
