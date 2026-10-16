// Generated from contracts/log-event.schema.json by scripts/contracts.sh. Do not edit.
export type LogEventName = "service.started" | "fetch.transcript" | "sponsorblock.call";

export interface LogEvent {
  ts: string;
  level: "debug" | "info" | "warn" | "error";
  service: "node" | "worker";
  event: LogEventName;
  request_id?: string;
  video_id?: string;
  attrs: {
    [k: string]: unknown;
  };
}
