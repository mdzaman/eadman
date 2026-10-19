/** RFC 9457 problem details. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string | undefined;
  instance?: string | undefined;
  code?: string | undefined;
  traceId?: string | undefined;
  errors?: Array<{ pointer: string; message: string }> | undefined;
}

export class DocOpsError extends Error {
  readonly code: string;
  readonly status: number;
  readonly errors: Array<{ pointer: string; message: string }>;

  constructor(code: string, message: string, status = 400, errors: Array<{ pointer: string; message: string }> = []) {
    super(message);
    this.name = "DocOpsError";
    this.code = code;
    this.status = status;
    this.errors = errors;
  }

  toProblem(traceId?: string): Problem {
    return {
      type: `https://docs.docops.example/errors/${this.code.replaceAll("_", "-")}`,
      title: this.message,
      status: this.status,
      code: this.code,
      traceId,
      errors: this.errors.length > 0 ? this.errors : undefined,
    };
  }
}

export const notFound = (what: string) => new DocOpsError("not_found", `${what} not found`, 404);
export const forbidden = (what = "Not permitted") => new DocOpsError("forbidden", what, 403);
export const unauthorized = (what = "Authentication required") => new DocOpsError("unauthorized", what, 401);
export const conflict = (what: string) => new DocOpsError("conflict", what, 409);
export const badRequest = (what: string, errors: Array<{ pointer: string; message: string }> = []) =>
  new DocOpsError("validation_failed", what, 400, errors);
