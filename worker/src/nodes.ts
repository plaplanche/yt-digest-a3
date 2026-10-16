import type { NodeClaimResponse } from "./contracts/node-claim-response";
import type { NodeHeartbeatResponse } from "./contracts/node-heartbeat-response";
import { isInteger, isText, isTimestamp, readObject, unknownFields } from "./body";
import type { Env } from "./env";
import { bearer, invalidRequest, json, notFound, unauthorized } from "./http";
import { log } from "./log";
import { sha256Hex } from "./tokens";

const DEFAULT_LEASE_SECONDS = 600;
const DEFAULT_MAX_JOBS = 3;

interface NodeRow {
  node_id: string;
  hourly_budget: number;
}

/** Looks the bearer up among the enrolled nodes; the failure is the 401 response. */
async function authenticate(request: Request, env: Env): Promise<NodeRow | Response> {
  const token = bearer(request);
  if (token === null) {
    log("auth.bearer.rejected", { attrs: { surface: "node", reason: "missing" } });
    return unauthorized();
  }
  const row = await env.DB.prepare("SELECT node_id, hourly_budget, revoked_at FROM nodes WHERE token_hash = ?1")
    .bind(await sha256Hex(token))
    .first<NodeRow & { revoked_at: string | null }>();
  if (row === null || row.revoked_at !== null) {
    log("auth.bearer.rejected", { attrs: { surface: "node", reason: row === null ? "unknown" : "revoked" } });
    return unauthorized();
  }
  return row;
}

const HEARTBEAT_FIELDS = ["version", "uptime_s", "jobs_in_progress", "last_success_at", "last_blocked_at", "disk_free_ratio", "cpu_temp_c"];

function heartbeatError(body: Record<string, unknown>): string | null {
  if (unknownFields(body, HEARTBEAT_FIELDS).length > 0) return "Unknown field";
  if (!isText(body.version, 1, 64)) return "version must be a string of 1 to 64 characters";
  if (!isInteger(body.uptime_s, 0)) return "uptime_s must be an integer >= 0";
  if (!isInteger(body.jobs_in_progress, 0)) return "jobs_in_progress must be an integer >= 0";
  for (const name of ["last_success_at", "last_blocked_at"]) {
    if (body[name] !== undefined && body[name] !== null && !isTimestamp(body[name])) return `${name} must be a timestamp or null`;
  }
  const ratio = body.disk_free_ratio;
  if (ratio !== undefined && !(typeof ratio === "number" && ratio >= 0 && ratio <= 1)) return "disk_free_ratio must be in [0, 1]";
  if (body.cpu_temp_c !== undefined && typeof body.cpu_temp_c !== "number") return "cpu_temp_c must be a number";
  return null;
}

async function heartbeat(request: Request, env: Env, node: NodeRow): Promise<Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const problem = heartbeatError(body);
  if (problem !== null) return invalidRequest(problem);
  await env.DB.prepare("UPDATE nodes SET last_heartbeat_at = ?1, version = ?2 WHERE node_id = ?3")
    .bind(new Date().toISOString(), body.version, node.node_id)
    .run();
  log("node.heartbeat", { attrs: { node_id: node.node_id, version: body.version, jobs_in_progress: body.jobs_in_progress } });
  const answer: NodeHeartbeatResponse = { node_id: node.node_id, state: "healthy", hourly_budget: node.hourly_budget, directive: "run" };
  return json(answer);
}

interface ClaimedRow {
  video_id: string;
  lease_id: string;
  lease_expires_at: string;
  priority: number;
  created_at: string;
  attempts: number;
}

/**
 * One UPDATE picks and marks the eligible jobs, so two claims never take the same job and each takes
 * what is left when it runs; the same D1 batch (one transaction) records the leases.
 */
async function claim(request: Request, env: Env, node: NodeRow): Promise<Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  if (unknownFields(body, ["max_jobs"]).length > 0) return invalidRequest("Unknown field");
  if (body.max_jobs !== undefined && !isInteger(body.max_jobs, 1, 10)) return invalidRequest("max_jobs must be an integer from 1 to 10");
  const maxJobs = body.max_jobs ?? DEFAULT_MAX_JOBS;

  const parsed = Number.parseInt(env.LEASE_SECONDS ?? "", 10);
  const leaseSeconds = Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LEASE_SECONDS;
  const now = new Date();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

  const [claimed] = await env.DB.batch<ClaimedRow>([
    env.DB.prepare(
      `UPDATE jobs SET status = 'leased', leased_by = ?1, lease_id = lower(hex(randomblob(16))), lease_expires_at = ?2,
         attempts = attempts + 1, tried_nodes = json_insert(tried_nodes, '$[#]', ?1)
       WHERE (video_id, kind) IN (
         SELECT video_id, kind FROM jobs
         WHERE status = 'queued' AND NOT EXISTS (SELECT 1 FROM json_each(jobs.tried_nodes) WHERE value = ?1)
         ORDER BY priority DESC, created_at ASC, video_id ASC LIMIT ?3)
       RETURNING video_id, lease_id, lease_expires_at, priority, created_at, attempts`,
    ).bind(node.node_id, expiresAt, maxJobs),
    env.DB.prepare(
      `INSERT INTO leases (lease_id, video_id, node_id, issued_at, expires_at, state)
       SELECT lease_id, video_id, leased_by, ?2, lease_expires_at, 'active' FROM jobs
       WHERE status = 'leased' AND leased_by = ?1 AND lease_id NOT IN (SELECT lease_id FROM leases)`,
    ).bind(node.node_id, issuedAt),
  ]);

  const rows = (claimed?.results ?? []).sort(
    (a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.video_id.localeCompare(b.video_id),
  );
  for (const row of rows) {
    log("job.claimed", { video_id: row.video_id, attrs: { node_id: node.node_id, attempt: row.attempts, lease_seconds: leaseSeconds } });
  }
  const answer: NodeClaimResponse = {
    jobs: rows.map(({ video_id, lease_id, lease_expires_at }) => ({ video_id, lease_id, lease_expires_at })),
  };
  return json(answer);
}

/** Handles `/node/*`: a known route needs a node token, anything else is a 404. */
export async function handleNode(request: Request, env: Env, path: string): Promise<Response> {
  const handler = request.method === "POST" ? { "/node/heartbeat": heartbeat, "/node/claim": claim }[path] : undefined;
  if (handler === undefined) return notFound();
  const node = await authenticate(request, env);
  if (node instanceof Response) return node;
  return handler(request, env, node);
}
