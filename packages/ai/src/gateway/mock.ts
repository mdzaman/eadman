import type {
  CitedGenerationRequest,
  CitedGenerationResult,
  LlmProvider,
  ModelRef,
  StructuredGenerationRequest,
  StructuredGenerationResult,
} from "./types.ts";

/** What a scripted `cited` handler returns; `model` defaults to the mock's own. */
export type MockCitedResult = Omit<CitedGenerationResult, "model"> & { model?: ModelRef };

export type MockCall =
  | { method: "generateWithCitations"; request: CitedGenerationRequest }
  | { method: "generateStructured"; request: StructuredGenerationRequest };

const MOCK_STATUS = Symbol("docops.mockStatus");

interface MockStatusMarker {
  [MOCK_STATUS]: { status: "refused" | "invalid" | "error"; error?: string };
}

/**
 * Return this from a `structured` handler to simulate a non-ok result
 * (a refusal, unparseable output or an API error) instead of a value.
 */
export function mockStructuredStatus(status: "refused" | "invalid" | "error", error?: string): unknown {
  const marker: MockStatusMarker = { [MOCK_STATUS]: error === undefined ? { status } : { status, error } };
  return marker;
}

function isStatusMarker(value: unknown): value is MockStatusMarker {
  return typeof value === "object" && value !== null && MOCK_STATUS in value;
}

export interface MockProviderOptions {
  cited?: (req: CitedGenerationRequest) => MockCitedResult | Promise<MockCitedResult>;
  structured?: (req: StructuredGenerationRequest) => unknown;
  model?: string;
}

/** Scripted provider for tests and offline evals. Records every call in `.calls`. */
export class MockProvider implements LlmProvider {
  readonly id = "mock";
  readonly model: string;
  readonly calls: MockCall[] = [];
  private readonly opts: MockProviderOptions;

  constructor(opts: MockProviderOptions = {}) {
    this.opts = opts;
    this.model = opts.model ?? "mock";
  }

  async generateWithCitations(req: CitedGenerationRequest): Promise<CitedGenerationResult> {
    this.calls.push({ method: "generateWithCitations", request: req });
    const model: ModelRef = { provider: this.id, model: this.model };
    if (!this.opts.cited) return { status: "not_documented", segments: [], model };
    try {
      const result = await this.opts.cited(req);
      return { ...result, model: result.model ?? model };
    } catch (error) {
      return { status: "error", segments: [], model, error: (error as Error).message };
    }
  }

  async generateStructured<T>(req: StructuredGenerationRequest): Promise<StructuredGenerationResult<T>> {
    this.calls.push({ method: "generateStructured", request: req });
    const model: ModelRef = { provider: this.id, model: this.model };
    if (!this.opts.structured) return { status: "error", model, error: "MockProvider: no structured handler" };
    try {
      const value = await this.opts.structured(req);
      if (isStatusMarker(value)) return { model, ...value[MOCK_STATUS] };
      return { status: "ok", value: value as T, model };
    } catch (error) {
      return { status: "error", model, error: (error as Error).message };
    }
  }
}
