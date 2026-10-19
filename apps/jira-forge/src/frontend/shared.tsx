/**
 * Small pieces shared by the five UI modules: a data-loading hook, status and error components,
 * and the "Link documentation" form used by both the issue panel and the issue action.
 *
 * Components are from @forge/react@12.3.1 (UI Kit 2); prop names and values were checked against
 * @atlaskit/forge-react-types@2.10.5 (the package that defines them) and the UI Kit docs at
 * https://developer.atlassian.com/platform/forge/ui-kit/components/.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  ErrorMessage,
  Form,
  FormFooter,
  Heading,
  Label,
  LoadingButton,
  Lozenge,
  RadioGroup,
  SectionMessage,
  SectionMessageAction,
  Spinner,
  Stack,
  Text,
  Textfield,
  useForm,
} from "@forge/react";

import type { PageSearchResult } from "../contract";
import { newIdempotencyKey } from "../validation";
import { toErrorViewModel } from "../view-model";
import type { ApiError, ApiResult, StatusLozenge } from "../view-model";
import { api } from "./api";

// ---- loading ----

export type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError };

/**
 * Runs `load` on mount and whenever `deps` change; `reload()` runs it again. Pass `null` while
 * there is nothing to load yet. `load` is a new closure on every render, so callers list what it
 * depends on in `deps`, and the list must keep the same length between renders.
 */
export function useLoader<T>(load: (() => Promise<ApiResult<T>>) | null, deps: readonly unknown[]): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (load === null) {
      setState({ status: "idle" });
      return undefined;
    }
    let current = true;
    setState({ status: "loading" });
    void load().then((result) => {
      if (current) setState(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
    });
    return () => {
      current = false;
    };
  }, [...deps, attempt]);
  return { state, reload: () => setAttempt((n) => n + 1) };
}

// ---- small components ----

export function Loading({ label }: { label: string }) {
  return <Spinner label={label} size="medium" />;
}

/** A status as text inside a colored lozenge, so the color is never the only signal. */
export function StatusBadge({ lozenge }: { lozenge: StatusLozenge }) {
  return <Lozenge appearance={lozenge.appearance}>{lozenge.text}</Lozenge>;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack space="space.100">
      <Heading size="small" as="h3">
        {title}
      </Heading>
      {children}
    </Stack>
  );
}

export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const view = toErrorViewModel(error);
  return (
    <SectionMessage
      appearance={view.appearance}
      title={view.title}
      actions={view.retryable && onRetry !== undefined ? <SectionMessageAction onClick={onRetry}>Try again</SectionMessageAction> : undefined}
    >
      <Text>{view.message}</Text>
      {view.reference !== undefined ? <Text size="small">Reference: {view.reference}</Text> : null}
    </SectionMessage>
  );
}

// ---- Link documentation ----

interface LinkDocsFormProps {
  /** The issue to link to; the resolver prefers the issue from the Forge context. */
  issueKey: string | undefined;
  onLinked: () => void;
  onCancel?: () => void;
}

/** Search the configured DocOps space, pick a page, link it to the issue (operation createLink). */
export function LinkDocsForm({ issueKey, onLinked, onCancel }: LinkDocsFormProps) {
  const { register, handleSubmit, getFieldId, formState } = useForm<{ query: string }>({ defaultValues: { query: "" } });
  const [search, setSearch] = useState<LoadState<PageSearchResult>>({ status: "idle" });
  const [searchedFor, setSearchedFor] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<ApiError | undefined>(undefined);

  const runSearch = async ({ query }: { query: string }) => {
    setSelectedId(undefined);
    setLinkError(undefined);
    setSearchedFor(query.trim());
    setSearch({ status: "loading" });
    const result = await api.searchPages(query);
    setSearch(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
  };

  const link = async () => {
    if (selectedId === undefined) return;
    setLinking(true);
    setLinkError(undefined);
    const result = await api.linkPage(issueKey, selectedId, newIdempotencyKey());
    setLinking(false);
    if (result.ok) onLinked();
    else setLinkError(result.error);
  };

  return (
    <Stack space="space.200">
      <Form onSubmit={handleSubmit(runSearch)}>
        <Label labelFor={getFieldId("query")}>Search documentation by title or path</Label>
        <Textfield {...register("query", { required: true, maxLength: 200 })} />
        {formState.errors.query ? <ErrorMessage>Enter a title or path, up to 200 characters.</ErrorMessage> : null}
        <FormFooter align="start">
          <Button type="submit" appearance="primary">
            Search
          </Button>
          {onCancel !== undefined ? (
            <Button appearance="subtle" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
        </FormFooter>
      </Form>

      {search.status === "loading" ? <Loading label="Searching documentation" /> : null}
      {search.status === "error" ? <ErrorNotice error={search.error} /> : null}
      {search.status === "ready" ? (
        search.data.items.length === 0 ? (
          <Text>No pages match "{searchedFor}".</Text>
        ) : (
          <Stack space="space.150">
            <Heading size="small" as="h3" id="docops-link-results">
              Choose a page to link
            </Heading>
            <RadioGroup
              name="docops-page"
              aria-labelledby="docops-link-results"
              options={search.data.items.map((page) => ({ name: "docops-page", value: page.id, label: `${page.title} (${page.path})` }))}
              onChange={(event) => setSelectedId(String(event.target.value))}
            />
            {search.data.hasMore ? <Text size="small">More pages match. Narrow the search to see them.</Text> : null}
            <LoadingButton appearance="primary" isLoading={linking} isDisabled={selectedId === undefined} onClick={link}>
              Link selected page
            </LoadingButton>
          </Stack>
        )
      ) : null}
      {linkError !== undefined ? <ErrorNotice error={linkError} /> : null}
    </Stack>
  );
}
