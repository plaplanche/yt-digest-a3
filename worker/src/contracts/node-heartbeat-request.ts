// Generated from contracts/node-heartbeat-request.schema.json by scripts/contracts.sh. Do not edit.
export interface NodeHeartbeatRequest {
  version: string;
  uptime_s: number;
  jobs_in_progress: number;
  last_success_at?: string | null;
  last_blocked_at?: string | null;
  disk_free_ratio?: number;
  cpu_temp_c?: number;
}
