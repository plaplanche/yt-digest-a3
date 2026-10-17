import pkg from "../package.json";
import type { Env } from "./env";
import { bearer, error, json } from "./http";
import { log } from "./log";
import { baseUrl } from "./oauth";
import { checkAccessToken } from "./token";
import { sha256Hex } from "./tokens";

const PROTOCOL_VERSION = "2025-06-18";
const TOOL_NAME = "list_subscriptions";

const TOOL = {
  name: TOOL_NAME,
  description: "Lists the YouTube subscriptions of the signed-in user.",
  inputSchema: { type: "object", properties: {} },
};

type Id = string | number | null;

const rpcResult = (id: Id, result: unknown): Response => json({ jsonrpc: "2.0", id, result });
const rpcError = (id: Id, code: number, message: string, status = 200): Response => json({ jsonrpc: "2.0", id, error: { code, message } }, status);

/** Why a bearer that failed section 10.6 was refused, for `auth.bearer.rejected`. */
async function rejectionReason(env: Env, token: string): Promise<"unknown" | "expired" | "revoked"> {
  const row = await env.DB.prepare("SELECT expires_at, revoked_at FROM oauth_tokens WHERE token_hash = ?1 AND kind = 'access'")
    .bind(await sha256Hex(token))
    .first<{ expires_at: string; revoked_at: string | null }>();
  if (row === null) return "unknown";
  if (row.revoked_at !== null) return "revoked";
  // An unexpired token that fails the check belongs to a user who is no longer admitted.
  return row.expires_at <= new Date().toISOString() ? "expired" : "revoked";
}

async function unauthorized(env: Env, token: string | null): Promise<Response> {
  log("auth.bearer.rejected", { attrs: { surface: "mcp", reason: token === null ? "missing" : await rejectionReason(env, token) } });
  return json({ error: "invalid_token" }, 401, {
    "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(env)}/.well-known/oauth-protected-resource"`,
  });
}

function callTool(id: Id, params: unknown): Response {
  const started = Date.now();
  const name = typeof params === "object" && params !== null ? (params as { name?: unknown }).name : undefined;
  const known = name === TOOL_NAME;
  log("mcp.tool.call", { attrs: { tool: typeof name === "string" ? name : "", outcome: known ? "ok" : "error", duration_ms: Date.now() - started } });
  if (!known) return rpcError(id, -32602, "Unknown tool");
  return rpcResult(id, { content: [{ type: "text", text: JSON.stringify({ subscriptions: [] }) }], isError: false });
}

/** POST /mcp (section 11). */
export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    const allowed = [new URL(baseUrl(env)).origin, ...(env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "")];
    if (!allowed.includes(origin)) {
      log("auth.origin.rejected", { attrs: { origin } });
      return error(403, "origin_rejected", "Origin not allowed");
    }
  }

  const token = bearer(request);
  if (token === null || (await checkAccessToken(env, token)) === null) return unauthorized(env, token);

  let message: unknown;
  try {
    message = JSON.parse(await request.text());
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) return rpcError(null, -32600, "Invalid Request", 400);
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: unknown };

  // A notification or a response from the client gets no answer body.
  if (typeof method !== "string" || id === undefined) return new Response(null, { status: 202 });
  if (typeof id !== "string" && typeof id !== "number") return rpcError(null, -32600, "Invalid Request", 400);

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "yt-digest", version: pkg.version },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: [TOOL] });
    case "tools/call":
      return callTool(id, params);
    default:
      return rpcError(id, -32601, "Method not found");
  }
}
