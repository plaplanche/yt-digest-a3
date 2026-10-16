// Generated from contracts/node-claim-response.schema.json by scripts/contracts.sh. Do not edit.
export interface NodeClaimResponse {
  jobs: {
    video_id: string;
    lease_id: string;
    lease_expires_at: string;
  }[];
}
