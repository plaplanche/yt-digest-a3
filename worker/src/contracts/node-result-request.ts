// Generated from contracts/node-result-request.schema.json by scripts/contracts.sh. Do not edit.
import type { TranscriptResult } from "./transcript-result";
export interface NodeResultRequest {
  lease_id: string;
  outcome: "ok" | "no_transcript" | "unavailable" | "blocked" | "error";
  transcript: TranscriptResult | null;
}
