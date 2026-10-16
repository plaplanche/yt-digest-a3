// Generated from contracts/log-event.schema.json by scripts/contracts.sh. Do not edit.
export type LogEventName =
  | "service.started"
  | "fetch.transcript"
  | "sponsorblock.call"
  | "node.enrolled"
  | "node.revoked"
  | "node.heartbeat"
  | "job.enqueued"
  | "job.claimed"
  | "job.completed"
  | "job.released"
  | "job.lease_expired"
  | "job.stale_result"
  | "job.validation_failed"
  | "auth.bearer.rejected"
  | "auth.client.registered"
  | "auth.oauth.completed"
  | "auth.oauth.denied"
  | "auth.token.issued"
  | "auth.refresh.reuse_detected"
  | "auth.origin.rejected"
  | "mcp.tool.call"
  | "worker.call";

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
