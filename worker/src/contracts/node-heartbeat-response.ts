// Generated from contracts/node-heartbeat-response.schema.json by scripts/contracts.sh. Do not edit.
export interface NodeHeartbeatResponse {
  node_id: string;
  state: "healthy" | "degraded" | "quarantined" | "offline" | "disabled";
  hourly_budget: number;
  directive: "run" | "pause" | "drain";
}
