import schema from "../../contracts/log-event.schema.json";
import type { LogEvent, LogEventName } from "./contracts/log-event";

export interface LogFields {
  level?: LogEvent["level"];
  request_id?: string;
  video_id?: string;
  attrs?: Record<string, unknown>;
}

const events: readonly string[] = schema.properties.event.enum;
const levels: readonly string[] = schema.properties.level.enum;
const fieldNames: readonly string[] = ["level", "request_id", "video_id", "attrs"];

/** Writes one JSON log line; throws for an event outside the catalogue, a bad level or an unknown field. */
export function log(event: LogEventName, fields: LogFields = {}): void {
  if (!events.includes(event)) {
    throw new Error(`unknown log event: ${event}`);
  }
  for (const name of Object.keys(fields)) {
    if (!fieldNames.includes(name)) {
      throw new Error(`unknown log field: ${name}`);
    }
  }
  const level = fields.level ?? "info";
  if (!levels.includes(level)) {
    throw new Error(`unknown log level: ${level}`);
  }
  const line: LogEvent = {
    ts: new Date().toISOString(),
    level,
    service: "worker",
    event,
    ...(fields.request_id !== undefined && { request_id: fields.request_id }),
    ...(fields.video_id !== undefined && { video_id: fields.video_id }),
    attrs: fields.attrs ?? {},
  };
  console.error(JSON.stringify(line));
}
