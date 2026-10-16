import type { Env } from "./env";
import { bearer, json, notFound, safeEqual, unauthorized } from "./http";
import { log } from "./log";

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
  return notFound();
}
