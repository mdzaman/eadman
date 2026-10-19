import { uuidv7 } from "./ids.ts";

/** CloudEvents 1.0 JSON envelope with DocOps extensions (tenantid, traceparent). */
export interface CloudEvent<T = unknown> {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string | undefined;
  time: string;
  tenantid: string;
  traceparent?: string | undefined;
  dataschema?: string | undefined;
  datacontenttype: "application/json";
  data: T;
}

export interface CloudEventOptions {
  tenantId: string;
  source?: string | undefined;
  subject?: string | undefined;
  traceparent?: string | undefined;
  id?: string | undefined;
  time?: Date | undefined;
}

export function cloudEvent<T>(type: string, data: T, options: CloudEventOptions): CloudEvent<T> {
  return {
    specversion: "1.0",
    id: options.id ?? uuidv7(),
    source: options.source ?? "docops://local",
    type,
    subject: options.subject,
    time: (options.time ?? new Date()).toISOString(),
    tenantid: options.tenantId,
    traceparent: options.traceparent,
    dataschema: `https://schemas.docops.example/events/${type}/v1.json`,
    datacontenttype: "application/json",
    data,
  };
}
