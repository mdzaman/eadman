/**
 * Docs readiness for a fix version (module jira:projectPage, resource `readiness`), as designed
 * in docs/06-jira-integration.md §9: summary line, a table with blockers first, and the bulk
 * "Create doc tasks for Missing" action.
 * Data: resolvers listFixVersions (Jira), getReadiness -> GET /v1/readiness and
 * createDocTasks -> POST /v1/readiness/doc-tasks.
 */
import React, { useState } from "react";
import ForgeReconciler, {
  DynamicTable,
  EmptyState,
  Form,
  FormFooter,
  Button,
  Heading,
  Inline,
  Label,
  Link,
  List,
  ListItem,
  LoadingButton,
  ProgressBar,
  SectionMessage,
  Select,
  Stack,
  Text,
  Textfield,
  useForm,
  useProductContext,
} from "@forge/react";

import type { DocTasksResult } from "../view-model";
import { newIdempotencyKey, readProjectKey } from "../validation";
import { defaultVersion, toDocTasksViewModel, toReadinessViewModel, toVersionOptions } from "../view-model";
import type { ApiResult, JiraVersion, ReadinessViewModel, VersionOption } from "../view-model";
import { api } from "./api";
import { ErrorNotice, Loading, StatusBadge, useLoader } from "./shared";

// ---- fix version ----

function VersionSelect({ options, value, onSelect }: { options: VersionOption[]; value: string | undefined; onSelect: (version: string) => void }) {
  const choices = options.map((option) => ({ label: option.label, value: option.value }));
  return (
    <Stack space="space.050">
      <Label labelFor="docops-fix-version">Fix version</Label>
      <Select
        inputId="docops-fix-version"
        options={choices}
        defaultValue={choices.find((choice) => choice.value === value)}
        onChange={(choice: { value?: unknown } | null) => {
          if (choice !== null && typeof choice.value === "string") onSelect(choice.value);
        }}
      />
    </Stack>
  );
}

/** Fallback when Jira's version list is unavailable: type the version name. */
function VersionInput({ onSelect }: { onSelect: (version: string) => void }) {
  const { register, handleSubmit, getFieldId } = useForm<{ fixVersion: string }>({ defaultValues: { fixVersion: "" } });
  return (
    <Form onSubmit={handleSubmit(({ fixVersion }) => onSelect(fixVersion.trim()))}>
      <Label labelFor={getFieldId("fixVersion")}>Fix version</Label>
      <Textfield {...register("fixVersion", { required: true, maxLength: 255 })} />
      <FormFooter align="start">
        <Button type="submit" appearance="primary">
          Show readiness
        </Button>
      </FormFooter>
    </Form>
  );
}

// ---- readiness ----

function Summary({ view }: { view: ReadinessViewModel }) {
  return (
    <Stack space="space.100">
      <Inline space="space.150" alignBlock="center" shouldWrap>
        <StatusBadge lozenge={view.overall} />
        <Text weight="semibold">{view.summaryText}</Text>
      </Inline>
      <ProgressBar value={view.readyPercent / 100} appearance={view.isReady ? "success" : "default"} ariaLabel={`Docs ready: ${view.readyPercentText} of ${view.total} issues`} />
      {view.asOfText !== undefined ? <Text size="small">{view.asOfText}</Text> : null}
    </Stack>
  );
}

const HEAD = {
  cells: [
    { key: "issue", content: "Issue" },
    { key: "summary", content: "Summary" },
    { key: "required", content: "Docs required" },
    { key: "status", content: "Docs status" },
    { key: "references", content: "Pages / PRs" },
  ],
};

function ReadinessTable({ view }: { view: ReadinessViewModel }) {
  const rows = view.rows.map((row) => ({
    key: row.key,
    cells: [
      {
        key: `${row.key}-issue`,
        content:
          row.url !== undefined ? (
            <Link href={row.url} openNewTab>
              {row.key}
            </Link>
          ) : (
            row.key
          ),
      },
      { key: `${row.key}-summary`, content: row.title },
      { key: `${row.key}-required`, content: row.docsRequiredLabel },
      { key: `${row.key}-status`, content: <StatusBadge lozenge={row.lozenge} /> },
      { key: `${row.key}-references`, content: row.references },
    ],
  }));
  // DynamicTable renders the header row from `head`; the order (blockers first) is set by the view-model.
  return <DynamicTable caption={view.title} head={HEAD} rows={rows} rowsPerPage={25} emptyView={<Text>No issues in this fix version.</Text>} />;
}

function TaskOutcome({ outcome }: { outcome: ApiResult<DocTasksResult> }) {
  if (!outcome.ok) return <ErrorNotice error={outcome.error} />;
  const view = toDocTasksViewModel(outcome.data);
  return (
    <SectionMessage appearance={view.appearance} title={view.headline}>
      {view.created.length > 0 ? (
        <List type="unordered">
          {view.created.map((task) => (
            <ListItem key={task.key}>
              {task.url !== undefined ? (
                <Link href={task.url} openNewTab>
                  {task.key}
                </Link>
              ) : (
                task.key
              )}{" "}
              for {task.parentKey}
            </ListItem>
          ))}
        </List>
      ) : null}
      {view.skipped.length > 0 ? (
        <List type="unordered">
          {view.skipped.map((entry) => (
            <ListItem key={`${entry.parentKey}-${entry.reason}`}>
              {entry.parentKey}: {entry.reason}
            </ListItem>
          ))}
        </List>
      ) : null}
    </SectionMessage>
  );
}

function VersionReadiness({ project, versions, timeZone }: { project: string | undefined; versions: JiraVersion[]; timeZone: string | undefined }) {
  const options = toVersionOptions(versions);
  const [version, setVersion] = useState<string | undefined>(defaultVersion(options));
  const [creating, setCreating] = useState(false);
  const [outcome, setOutcome] = useState<ApiResult<DocTasksResult> | undefined>(undefined);
  const { state, reload } = useLoader(version === undefined ? null : () => api.getReadiness(project, version), [project, version]);

  const select = (next: string) => {
    setOutcome(undefined);
    setVersion(next);
  };

  const createTasks = async (view: ReadinessViewModel) => {
    if (version === undefined) return;
    setCreating(true);
    setOutcome(undefined);
    const result = await api.createDocTasks(project, version, view.missingKeys, newIdempotencyKey());
    setCreating(false);
    setOutcome(result);
    if (result.ok) reload();
  };

  const picker = options.length > 0 ? <VersionSelect options={options} value={version} onSelect={select} /> : <VersionInput onSelect={select} />;

  if (version === undefined) return picker;
  if (state.status === "idle" || state.status === "loading") {
    return (
      <Stack space="space.200">
        {picker}
        <Loading label="Loading docs readiness" />
      </Stack>
    );
  }
  if (state.status === "error") {
    return (
      <Stack space="space.200">
        {picker}
        <ErrorNotice error={state.error} onRetry={reload} />
      </Stack>
    );
  }

  const view = toReadinessViewModel(state.data, timeZone === undefined ? {} : { timeZone });
  return (
    <Stack space="space.200">
      {picker}
      {view.isEmpty ? (
        <EmptyState header="No issues in this fix version" description={`DocOps found no issues in ${project ?? "this project"} with fix version ${view.fixVersion}.`} />
      ) : (
        <>
          <Summary view={view} />
          <Inline space="space.100" shouldWrap>
            <LoadingButton appearance="primary" isLoading={creating} isDisabled={view.missingKeys.length === 0} onClick={() => createTasks(view)}>
              {view.createTasksLabel}
            </LoadingButton>
          </Inline>
          {outcome !== undefined ? <TaskOutcome outcome={outcome} /> : null}
          <ReadinessTable view={view} />
        </>
      )}
    </Stack>
  );
}

function ReadinessPage({ project, timeZone }: { project: string | undefined; timeZone: string | undefined }) {
  // The version list comes from Jira as the viewing user. If it fails, the page still works with a typed version.
  const { state } = useLoader(() => api.listFixVersions(project), [project]);
  if (state.status === "idle" || state.status === "loading") return <Loading label="Loading fix versions" />;
  return <VersionReadiness project={project} versions={state.status === "ready" ? state.data : []} timeZone={timeZone} />;
}

function App() {
  const context = useProductContext();
  if (context === undefined) return <Loading label="Loading" />;
  const project = readProjectKey(context, undefined);
  return (
    <Stack space="space.200">
      <Heading size="large" as="h2">
        {`Docs readiness${project === undefined ? "" : ` · ${project}`}`}
      </Heading>
      <ReadinessPage project={project} timeZone={context.timezone} />
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
