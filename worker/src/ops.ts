import type { Env } from "./env";
import { VIDEO_ID, isInteger, isText, readObject, unknownFields } from "./body";
import { bearer, error, invalidRequest, json, notFound, safeEqual, unauthorized } from "./http";
import { revokeNode, sweepExpired } from "./leases";
import { log } from "./log";
import { transcriptKey } from "./results";
import { newNodeToken, sha256Hex } from "./tokens";

const TABLES = [
  "nodes",
  "jobs",
  "leases",
  "node_events",
  "invites",
  "users",
  "oauth_clients",
  "oauth_requests",
  "oauth_codes",
  "oauth_tokens",
] as const;

const TRANSCRIPT_PREFIX = "transcripts/";

async function reset(env: Env): Promise<Response> {
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)));
  let cursor: string | undefined;
  do {
    const page = await env.TRANSCRIPTS.list({ prefix: TRANSCRIPT_PREFIX, cursor });
    if (page.objects.length > 0) {
      await env.TRANSCRIPTS.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return json({ ok: true });
}

async function enrollNode(request: Request, env: Env): Promise<Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  if (unknownFields(body, ["node_id", "owner_label"]).length > 0) return invalidRequest("Unknown field");
  const { node_id: nodeId, owner_label: ownerLabel } = body;
  if (typeof nodeId !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(nodeId)) return invalidRequest("Invalid node_id");
  if (!isText(ownerLabel, 1, 100)) return invalidRequest("owner_label must be 1 to 100 characters");
  const token = newNodeToken();
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    "INSERT INTO nodes (node_id, owner_label, token_hash, state, state_since, created_at) VALUES (?1, ?2, ?3, 'healthy', ?4, ?4) ON CONFLICT (node_id) DO NOTHING",
  )
    .bind(nodeId, ownerLabel, await sha256Hex(token), now)
    .run();
  if (inserted.meta.changes === 0) return error(409, "conflict", "Node already exists");
  log("node.enrolled", { attrs: { node_id: nodeId } });
  return json({ node_id: nodeId, owner_label: ownerLabel, token });
}

async function enqueueJobs(request: Request, env: Env): Promise<Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  if (unknownFields(body, ["video_ids", "priority"]).length > 0) return invalidRequest("Unknown field");
  const ids = body.video_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100) return invalidRequest("video_ids must hold 1 to 100 ids");
  if (!ids.every((id): id is string => typeof id === "string" && VIDEO_ID.test(id))) return invalidRequest("Invalid video id");
  const priority = body.priority ?? 0;
  if (!isInteger(priority, 0)) return invalidRequest("priority must be an integer >= 0");

  const now = new Date().toISOString();
  const results = await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare("INSERT INTO jobs (video_id, kind, priority, created_at) VALUES (?1, 'primary', ?2, ?3) ON CONFLICT (video_id, kind) DO NOTHING").bind(id, priority, now),
      env.DB.prepare("UPDATE jobs SET priority = ?2 WHERE video_id = ?1 AND kind = 'primary' AND priority < ?2").bind(id, priority),
    ]),
  );
  const enqueued: string[] = [];
  const existing: string[] = [];
  ids.forEach((id, i) => (results[2 * i]?.meta.changes === 1 ? enqueued : existing).push(id));
  if (enqueued.length > 0) log("job.enqueued", { attrs: { count: enqueued.length, priority } });
  return json({ enqueued, existing });
}

/** Reads `{"email"}` and returns the lowercased e-mail, or the 400 response. */
async function readEmail(request: Request): Promise<string | Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  if (unknownFields(body, ["email"]).length > 0) return invalidRequest("Unknown field");
  if (typeof body.email !== "string" || !body.email.includes("@")) return invalidRequest("email must be a string containing @");
  return body.email.toLowerCase();
}

async function invite(request: Request, env: Env): Promise<Response> {
  const email = await readEmail(request);
  if (email instanceof Response) return email;
  await env.DB.prepare("INSERT INTO invites (email, invited_at) VALUES (?1, ?2) ON CONFLICT (email) DO UPDATE SET revoked = 0")
    .bind(email, new Date().toISOString())
    .run();
  return json({ email, revoked: false });
}

async function revokeInvite(request: Request, env: Env): Promise<Response> {
  const email = await readEmail(request);
  if (email instanceof Response) return email;
  const updated = await env.DB.prepare("UPDATE invites SET revoked = 1 WHERE email = ?1").bind(email).run();
  return updated.meta.changes === 0 ? notFound() : json({ email, revoked: true });
}

async function listUsers(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT user_sub, email, role FROM users ORDER BY email").all<{ user_sub: string; email: string; role: string }>();
  return json({ users: results });
}

interface JobRow {
  video_id: string;
  kind: string;
  priority: number;
  status: string;
  leased_by: string | null;
  lease_expires_at: string | null;
  attempts: number;
  tried_nodes: string;
  last_outcome: string | null;
  created_at: string;
  done_at: string | null;
}

async function showJob(env: Env, videoId: string): Promise<Response> {
  await sweepExpired(env);
  const row = await env.DB.prepare(
    "SELECT video_id, kind, priority, status, leased_by, lease_expires_at, attempts, tried_nodes, last_outcome, created_at, done_at FROM jobs WHERE video_id = ?1 AND kind = 'primary'",
  )
    .bind(videoId)
    .first<JobRow>();
  if (row === null) return notFound();
  return json({ ...row, tried_nodes: JSON.parse(row.tried_nodes) as string[] });
}

async function showTranscript(env: Env, videoId: string): Promise<Response> {
  const object = VIDEO_ID.test(videoId) ? await env.TRANSCRIPTS.get(transcriptKey(videoId)) : null;
  if (object === null) return notFound();
  const meta = object.customMetadata ?? {};
  return json({
    video_id: videoId,
    transcript: JSON.parse(await object.text()) as unknown,
    node_id: meta.node_id ?? null,
    lease_id: meta.lease_id ?? null,
    produced_at: meta.produced_at ?? null,
  });
}

/** Handles `/ops/*`: absent without `OPS_TOKEN`, otherwise behind the operator bearer, checked before anything else. */
export async function handleOps(request: Request, env: Env, path: string): Promise<Response> {
  const expected = env.OPS_TOKEN ?? "";
  if (expected === "") {
    return notFound();
  }
  const token = bearer(request);
  if (token === null) {
    log("auth.bearer.rejected", { attrs: { surface: "ops", reason: "missing" } });
    return unauthorized();
  }
  if (!(await safeEqual(token, expected))) {
    log("auth.bearer.rejected", { attrs: { surface: "ops", reason: "unknown" } });
    return unauthorized();
  }
  if (request.method === "POST" && path === "/ops/reset") {
    return reset(env);
  }
  if (request.method === "POST" && path === "/ops/nodes") {
    return enrollNode(request, env);
  }
  if (request.method === "POST" && path === "/ops/jobs") {
    return enqueueJobs(request, env);
  }
  if (request.method === "POST" && path === "/ops/invites") {
    return invite(request, env);
  }
  if (request.method === "POST" && path === "/ops/invites/revoke") {
    return revokeInvite(request, env);
  }
  if (request.method === "GET" && path === "/ops/users") {
    return listUsers(env);
  }
  const job = /^\/ops\/jobs\/([^/]+)$/.exec(path);
  if (request.method === "GET" && job?.[1] !== undefined) {
    return showJob(env, job[1]);
  }
  const transcript = /^\/ops\/transcripts\/([^/]+)$/.exec(path);
  if (request.method === "GET" && transcript?.[1] !== undefined) {
    return showTranscript(env, transcript[1]);
  }
  const node = /^\/ops\/nodes\/([^/]+)$/.exec(path);
  if (request.method === "DELETE" && node?.[1] !== undefined) {
    return (await revokeNode(env, node[1])) === null ? notFound() : json({ node_id: node[1], state: "disabled" });
  }
  return notFound();
}
