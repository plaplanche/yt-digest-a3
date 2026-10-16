import type { NodeJobAck } from "./contracts/node-job-ack";
import type { Env } from "./env";
import { log } from "./log";

export const MAX_ATTEMPTS = 3;

/** A failed job goes back to the queue, or is given up on after its last attempt (8.7). */
export const failedStatus = (attempts: number): NodeJobAck["status"] => (attempts >= MAX_ATTEMPTS ? "failed_video" : "queued");

/** 8.7: `?1` is now, `?2` the `last_outcome`; the caller appends the condition on `?3`. */
export const FAIL_JOB = `UPDATE jobs SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed_video' ELSE 'queued' END,
  done_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN ?1 ELSE done_at END,
  leased_by = NULL, lease_id = NULL, lease_expires_at = NULL, last_outcome = ?2
  WHERE status = 'leased' AND `;

export interface LeaseRow {
  lease_id: string;
  video_id: string;
  node_id: string;
  state: string;
  response_json: string | null;
}

export interface Ending {
  now: string;
  /** The lease state it ends in. */
  leaseState: "completed" | "rejected" | "expired";
  /** The job's `last_outcome`. */
  outcome: string;
  /** The `node_events.kind` to record, if any. */
  eventKind: string | null;
  /** The body stored as the lease's `response_json`. */
  response: NodeJobAck | null;
}

// Each ending is one D1 batch (one transaction) whose statements all depend on the lease still being
// `active`: of two concurrent endings of the same lease, only the one changing the lease row counts.
const recordEvent = (env: Env, lease: LeaseRow, kind: string, now: string): D1PreparedStatement =>
  env.DB.prepare(
    "INSERT INTO node_events (node_id, ts, kind, video_id) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM leases WHERE lease_id = ?5 AND state = 'active')",
  ).bind(lease.node_id, now, kind, lease.video_id, lease.lease_id);

const endLease = (env: Env, lease: LeaseRow, state: string, response: NodeJobAck | null): D1PreparedStatement =>
  env.DB.prepare("UPDATE leases SET state = ?2, response_json = ?3 WHERE lease_id = ?1 AND state = 'active'").bind(
    lease.lease_id,
    state,
    response === null ? null : JSON.stringify(response),
  );

/** Ends the lease of a job that failed; true when this call is the one that ended it. */
export async function endFailed(env: Env, lease: LeaseRow, ending: Ending): Promise<boolean> {
  const statements = [
    ...(ending.eventKind === null ? [] : [recordEvent(env, lease, ending.eventKind, ending.now)]),
    env.DB.prepare(`${FAIL_JOB}lease_id = ?3`).bind(ending.now, ending.outcome, lease.lease_id),
    endLease(env, lease, ending.leaseState, ending.response),
  ];
  const results = await env.DB.batch(statements);
  return results[results.length - 1]?.meta.changes === 1;
}

/** Ends the lease of a job that is finished; true when this call is the one that ended it. */
export async function endDone(env: Env, lease: LeaseRow, ending: Ending): Promise<boolean> {
  const statements = [
    ...(ending.eventKind === null ? [] : [recordEvent(env, lease, ending.eventKind, ending.now)]),
    env.DB.prepare("UPDATE jobs SET status = 'done', done_at = ?1, last_outcome = ?2 WHERE video_id = ?3 AND kind = 'primary' AND lease_id = ?4 AND status = 'leased'").bind(
      ending.now,
      ending.outcome,
      lease.video_id,
      lease.lease_id,
    ),
    endLease(env, lease, ending.leaseState, ending.response),
  ];
  const results = await env.DB.batch(statements);
  return results[results.length - 1]?.meta.changes === 1;
}

/** Undoes a claim (8.5); true when this call is the one that released the lease. */
export async function release(env: Env, lease: LeaseRow, response: NodeJobAck): Promise<boolean> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'queued', leased_by = NULL, lease_id = NULL, lease_expires_at = NULL, attempts = attempts - 1,
         tried_nodes = (SELECT json_group_array(value) FROM json_each(jobs.tried_nodes) WHERE value != ?1), last_outcome = 'released'
       WHERE video_id = ?2 AND kind = 'primary' AND lease_id = ?3 AND status = 'leased'`,
    ).bind(lease.node_id, lease.video_id, lease.lease_id),
    endLease(env, lease, "released", response),
  ]);
  return results[1]?.meta.changes === 1;
}

interface ExpiredRow {
  video_id: string;
  lease_id: string;
  leased_by: string;
  attempts: number;
}

/** 8.6: every leased job whose lease expires at or before now fails over to another node. */
export async function sweepExpired(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare("SELECT video_id, lease_id, leased_by, attempts FROM jobs WHERE status = 'leased' AND lease_expires_at <= ?1")
    .bind(now)
    .all<ExpiredRow>();
  for (const row of results) {
    const lease: LeaseRow = { lease_id: row.lease_id, video_id: row.video_id, node_id: row.leased_by, state: "active", response_json: null };
    const ended = await endFailed(env, lease, { now, leaseState: "expired", outcome: "lease_expired", eventKind: "lease_expired", response: null });
    if (ended) {
      log("job.lease_expired", { video_id: row.video_id, attrs: { node_id: row.leased_by, attempts: row.attempts, status: failedStatus(row.attempts) } });
    }
  }
}

/** 8.8: disables the node and fails over every job it holds; null for an unknown node. */
export async function revokeNode(env: Env, nodeId: string): Promise<{ leasesRevoked: number } | null> {
  const node = await env.DB.prepare("SELECT revoked_at FROM nodes WHERE node_id = ?1").bind(nodeId).first<{ revoked_at: string | null }>();
  if (node === null) return null;
  if (node.revoked_at !== null) return { leasesRevoked: 0 };
  const now = new Date().toISOString();
  const [revoked, , leases] = await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET state = 'disabled', state_since = ?2, revoked_at = ?2 WHERE node_id = ?1 AND revoked_at IS NULL").bind(nodeId, now),
    env.DB.prepare(`${FAIL_JOB}leased_by = ?3`).bind(now, "lease_revoked", nodeId),
    env.DB.prepare("UPDATE leases SET state = 'revoked' WHERE node_id = ?1 AND state = 'active'").bind(nodeId),
  ]);
  const leasesRevoked = leases?.meta.changes ?? 0;
  if (revoked?.meta.changes === 1) log("node.revoked", { attrs: { node_id: nodeId, leases_revoked: leasesRevoked } });
  return { leasesRevoked };
}
