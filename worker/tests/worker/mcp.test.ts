import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { call, ops } from "./helpers";
import type { Env } from "../../src/env";

const BASE = "http://worker.test";
const settings: Partial<Env> = { OPS_TOKEN: "ops-test", PUBLIC_URL: BASE, ADMIN_EMAIL: "alice@test" };
const METADATA = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

const hex = async (value: string): Promise<string> =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, "0")).join("");

async function accessToken(name: string, over: { user?: string; expiresIn?: number; revoked?: boolean } = {}): Promise<string> {
  const token = `access-${name}-${"x".repeat(32)}`;
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, family_id, scope, resource, expires_at, revoked_at) VALUES (?1, 'access', 'c', ?2, 'f', 'digest', ?3, ?4, ?5)",
  )
    .bind(await hex(token), over.user ?? "u-bob", `${BASE}/mcp`, new Date(Date.now() + (over.expiresIn ?? 3600) * 1000).toISOString(), over.revoked ? new Date().toISOString() : null)
    .run();
  return token;
}

const rpc = (body: unknown, headers: Record<string, string> = {}, over: Partial<Env> = {}): Promise<Response> =>
  call("/mcp", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }, { ...settings, ...over });
const as = (token: string, body: unknown, headers: Record<string, string> = {}, over: Partial<Env> = {}): Promise<Response> =>
  rpc(body, { Authorization: `Bearer ${token}`, ...headers }, over);
const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

let good = "";
beforeEach(async () => {
  await ops("/ops/reset", { method: "POST" });
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES ('u-bob', 'bob@test', 'member', ?1)").bind(now).run();
  await env.DB.prepare("INSERT INTO invites (email, invited_at, revoked) VALUES ('bob@test', ?1, 0)").bind(now).run();
  good = await accessToken("good");
});
afterEach(() => vi.restoreAllMocks());

const logged = (spy: { mock: { calls: unknown[][] } }): { event: string; attrs: Record<string, unknown> }[] =>
  spy.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; attrs: Record<string, unknown> });

describe("POST /mcp authentication", () => {
  test("no token, an unknown token, an expired token, a revoked one, a node token and the operator token get 401 with WWW-Authenticate", async () => {
    const node = (await (await ops("/ops/nodes", { method: "POST", body: JSON.stringify({ node_id: "n-1", owner_label: "o" }) })).json()) as { token: string };
    const expired = await accessToken("expired", { expiresIn: -5 });
    const revoked = await accessToken("revoked", { revoked: true });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cases: [string | null, string][] = [
      [null, "missing"],
      ["nope", "unknown"],
      [expired, "expired"],
      [revoked, "revoked"],
      [node.token, "unknown"],
      ["ops-test", "unknown"],
    ];
    for (const [token] of cases) {
      const response = token === null ? await rpc(init) : await as(token, init);
      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe(METADATA);
      expect(await response.json()).toMatchObject({ error: "invalid_token" });
    }
    const rejected = logged(spy).filter((l) => l.event === "auth.bearer.rejected");
    expect(rejected.map((l) => l.attrs)).toEqual(cases.map(([, reason]) => ({ surface: "mcp", reason })));
    expect(spy.mock.calls.join("\n")).not.toContain(node.token);
  });

  test("a token of a user whose invite was revoked gets 401", async () => {
    expect((await as(good, init)).status).toBe(200);
    expect((await ops("/ops/invites/revoke", { method: "POST", body: JSON.stringify({ email: "bob@test" }) })).status).toBe(200);
    const response = await as(good, init);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(METADATA);
  });

  test("an access token gets 401 on /node/*", async () => {
    const response = await call("/node/claim", { method: "POST", headers: { Authorization: `Bearer ${good}` }, body: JSON.stringify({ max_jobs: 1 }) }, settings);
    expect(response.status).toBe(401);
  });

  test("only POST is routed", async () => {
    expect((await call("/mcp", { method: "GET", headers: { Authorization: `Bearer ${good}` } }, settings)).status).toBe(404);
  });
});

describe("Origin check", () => {
  test("a foreign Origin gets 403 origin_rejected before authentication and is logged", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await rpc(init, { Origin: "http://evil.test" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "origin_rejected", message: expect.any(String) } });
    const lines = logged(spy);
    expect(lines.map((l) => l.event)).toEqual(["auth.origin.rejected"]);
    expect(lines[0]?.attrs).toEqual({ origin: "http://evil.test" });
  });

  test("the origin of PUBLIC_URL, a listed origin and an absent Origin pass", async () => {
    expect((await as(good, init, { Origin: BASE })).status).toBe(200);
    expect((await as(good, init, { Origin: "http://other.test:3000" }, { ALLOWED_ORIGINS: "http://a.test, http://other.test:3000" })).status).toBe(200);
    expect((await as(good, init)).status).toBe(200);
    expect((await as(good, init, { Origin: "http://other.test:3000" })).status).toBe(403);
  });
});

describe("MCP methods", () => {
  test("initialize answers protocolVersion 2025-06-18", async () => {
    const response = await as(good, init);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "yt-digest" } } });
  });

  test("a notification gets 202 without a body", async () => {
    const response = await as(good, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("ping answers an empty result", async () => {
    expect(await (await as(good, { jsonrpc: "2.0", id: "p", method: "ping" })).json()).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
  });

  test("tools/list returns exactly list_subscriptions with an empty object schema", async () => {
    const body = (await (await as(good, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(["list_subscriptions"]);
    expect(body.result.tools[0]?.inputSchema).toEqual({ type: "object", properties: {} });
  });

  test("tools/call returns the empty subscriptions and logs mcp.tool.call", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await (await as(good, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_subscriptions", arguments: {} } })).json();
    expect(body).toEqual({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: '{"subscriptions":[]}' }], isError: false } });
    const event = logged(spy).find((l) => l.event === "mcp.tool.call");
    expect(event?.attrs).toMatchObject({ tool: "list_subscriptions", outcome: "ok" });
    expect(typeof event?.attrs.duration_ms).toBe("number");
  });

  test("an unknown tool, an unknown method and a bad body give JSON-RPC errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tool = await (await as(good, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "other" } })).json();
    expect(tool).toMatchObject({ id: 4, error: { code: -32602 } });
    expect(logged(spy).find((l) => l.event === "mcp.tool.call")?.attrs).toMatchObject({ tool: "other", outcome: "error" });
    expect(await (await as(good, { jsonrpc: "2.0", id: 5, method: "nope" })).json()).toMatchObject({ id: 5, error: { code: -32601 } });
    const garbage = await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${good}` }, body: "{" }, settings);
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toMatchObject({ error: { code: -32700 } });
    const batch = await as(good, [init]);
    expect(batch.status).toBe(400);
  });
});
