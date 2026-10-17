import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { call, ops } from "./helpers";
import type { Env } from "../../src/env";
import { checkAccessToken } from "../../src/token";

const BASE = "http://worker.test";
const REDIRECT = "http://127.0.0.1:9/cb";
const VERIFIER = "v".repeat(50);
const settings: Partial<Env> = { OPS_TOKEN: "ops-test", PUBLIC_URL: BASE, ADMIN_EMAIL: "alice@test" };
const full = (over: Partial<Env> = {}): Env => ({ DB: env.DB, TRANSCRIPTS: env.TRANSCRIPTS, ...settings, ...over });
const api = (path: string, init: RequestInit = {}, over: Partial<Env> = {}): Promise<Response> => call(path, init, { ...settings, ...over });

const sha256 = async (value: string): Promise<ArrayBuffer> => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
const hex = async (value: string): Promise<string> => Array.from(new Uint8Array(await sha256(value)), (b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (data: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let counter = 0;
const CLIENT = "client-one-0123456789";
const OTHER_CLIENT = "client-two-0123456789";

async function seed(): Promise<void> {
  await ops("/ops/reset", { method: "POST" });
  for (const id of [CLIENT, OTHER_CLIENT]) {
    await env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?1, NULL, ?2, ?3)").bind(id, JSON.stringify([REDIRECT]), new Date().toISOString()).run();
  }
  await env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES ('u-bob', 'bob@test', 'member', ?1)").bind(new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO invites (email, invited_at, revoked) VALUES ('bob@test', ?1, 0)").bind(new Date().toISOString()).run();
}

/** Stores an authorization code and returns it. */
async function newCode(over: { expiresIn?: number; client?: string; user?: string; challenge?: string } = {}): Promise<string> {
  const code = `code-${++counter}-${"x".repeat(32)}`;
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, user_sub, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, 'digest', ?6, ?7)",
  )
    .bind(await hex(code), over.client ?? CLIENT, over.user ?? "u-bob", REDIRECT, over.challenge ?? b64url(await sha256(VERIFIER)), `${BASE}/mcp`, new Date(Date.now() + (over.expiresIn ?? 60) * 1000).toISOString())
    .run();
  return code;
}

const form = (fields: Record<string, string | null>): RequestInit => {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) if (value !== null) body.set(name, value);
  return { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() };
};

const codeGrant = (code: string, over: Record<string, string | null> = {}): RequestInit =>
  form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER, resource: `${BASE}/mcp`, ...over });
const refreshGrant = (refresh_token: string, over: Record<string, string | null> = {}): RequestInit =>
  form({ grant_type: "refresh_token", refresh_token, client_id: CLIENT, ...over });

interface Tokens {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}
async function exchange(over: Partial<Env> = {}): Promise<Tokens> {
  const response = await api("/token", codeGrant(await newCode()), over);
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
}
const refreshWith = (token: string, over: Record<string, string | null> = {}): Promise<Response> => api("/token", refreshGrant(token, over));
const rows = async (sql: string): Promise<Record<string, unknown>[]> => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;

beforeEach(seed);
afterEach(() => vi.restoreAllMocks());

describe("POST /token, authorization_code", () => {
  test("issues an opaque pair bound to the resource, with no-store", async () => {
    const response = await api("/token", codeGrant(await newCode()));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = (await response.json()) as Tokens;
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "digest" });
    expect(body.access_token.length).toBeGreaterThanOrEqual(32);
    expect(body.refresh_token.length).toBeGreaterThanOrEqual(32);
    expect(body.access_token).not.toBe(body.refresh_token);
    const stored = await rows("SELECT kind, client_id, user_sub, scope, resource, token_hash FROM oauth_tokens ORDER BY kind");
    expect(stored).toHaveLength(2);
    expect(stored.map((r) => r.kind)).toEqual(["access", "refresh"]);
    expect(stored[0]).toMatchObject({ client_id: CLIENT, user_sub: "u-bob", scope: "digest", resource: `${BASE}/mcp`, token_hash: await hex(body.access_token) });
    expect(stored[1]?.token_hash).toBe(await hex(body.refresh_token));
    const families = await rows("SELECT DISTINCT family_id FROM oauth_tokens");
    expect(families).toHaveLength(1);
  });

  test("expires_in and the stored lifetimes follow the settings", async () => {
    const before = Date.now();
    const body = await exchange({ ACCESS_TOKEN_TTL_SECONDS: "120", REFRESH_TOKEN_TTL_SECONDS: "7200" });
    expect(body.expires_in).toBe(120);
    const [access, refresh] = await rows("SELECT expires_at FROM oauth_tokens ORDER BY kind");
    expect(Date.parse(String(access?.expires_at)) - before).toBeGreaterThan(110_000);
    expect(Date.parse(String(access?.expires_at)) - before).toBeLessThan(130_000);
    expect(Date.parse(String(refresh?.expires_at)) - before).toBeGreaterThan(7_190_000);
    expect(Date.parse(String(refresh?.expires_at)) - before).toBeLessThan(7_210_000);
  });

  test("logs auth.token.issued without any token", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const body = await exchange();
    const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(text).toContain('"event":"auth.token.issued"');
    expect(text).toContain(`"attrs":{"client_id":"${CLIENT}","grant_type":"authorization_code"}`);
    expect(text).not.toContain(body.access_token);
    expect(text).not.toContain(body.refresh_token);
  });

  test("an unknown client gives 401 invalid_client", async () => {
    const response = await api("/token", codeGrant(await newCode(), { client_id: "nobody" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  test("a wrong verifier gives invalid_grant", async () => {
    const response = await api("/token", codeGrant(await newCode(), { code_verifier: "w".repeat(50) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect(await rows("SELECT * FROM oauth_tokens")).toEqual([]);
  });

  test("a used code gives invalid_grant and issues nothing more", async () => {
    const code = await newCode();
    expect((await api("/token", codeGrant(code))).status).toBe(200);
    const again = await api("/token", codeGrant(code));
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_grant" });
    expect(await rows("SELECT * FROM oauth_tokens")).toHaveLength(2);
  });

  test("an expired code and an unknown code give invalid_grant", async () => {
    for (const code of [await newCode({ expiresIn: -1 }), "unknown-code"]) {
      const response = await api("/token", codeGrant(code));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  });

  test("a code issued to another client gives invalid_grant", async () => {
    const response = await api("/token", codeGrant(await newCode({ client: OTHER_CLIENT })));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test("another redirect_uri gives invalid_grant", async () => {
    const response = await api("/token", codeGrant(await newCode(), { redirect_uri: `${REDIRECT}2` }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  test.each(["code", "redirect_uri", "client_id", "code_verifier", "resource"])("a missing %s gives invalid_request", async (name) => {
    const response = await api("/token", codeGrant(await newCode(), { [name]: null }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  test("a wrong resource gives invalid_target, and does not use the code up", async () => {
    const code = await newCode();
    for (const resource of [`${BASE}/other`, `${BASE}/mcp/`, "http://evil.test/mcp"]) {
      const response = await api("/token", codeGrant(code, { resource }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_target" });
    }
    expect((await api("/token", codeGrant(code))).status).toBe(200);
  });

  test("a code is used up by a failed exchange", async () => {
    const code = await newCode();
    expect((await api("/token", codeGrant(code, { code_verifier: "w".repeat(50) }))).status).toBe(400);
    const retry = await api("/token", codeGrant(code));
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: "invalid_grant" });
    const code2 = await newCode();
    expect((await api("/token", codeGrant(code2, { client_id: OTHER_CLIENT }))).status).toBe(400);
    expect((await api("/token", codeGrant(code2))).status).toBe(400);
  });

  test("the checks run in order: grant type, client, missing parameters, resource, code", async () => {
    const body = async (r: Response): Promise<unknown> => r.json();
    expect(await body(await api("/token", form({ grant_type: "password", client_id: "nobody" })))).toMatchObject({ error: "unsupported_grant_type" });
    expect(await body(await api("/token", codeGrant("c", { client_id: "nobody", resource: null })))).toMatchObject({ error: "invalid_client" });
    expect(await body(await api("/token", codeGrant("c", { redirect_uri: null, resource: "http://x/mcp" })))).toMatchObject({ error: "invalid_request" });
    expect(await body(await api("/token", codeGrant("unknown", { resource: "http://x/mcp" })))).toMatchObject({ error: "invalid_target" });
  });
});

describe("POST /token, errors common to both grants", () => {
  test("an unknown grant gives 400 unsupported_grant_type", async () => {
    const response = await api("/token", form({ grant_type: "client_credentials", client_id: CLIENT }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });

  test("a missing grant_type gives invalid_request", async () => {
    const response = await api("/token", form({ client_id: CLIENT }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  test("a body that is not form-encoded gives invalid_request", async () => {
    const fields = { grant_type: "authorization_code", code: await newCode(), redirect_uri: REDIRECT, client_id: CLIENT, code_verifier: VERIFIER, resource: `${BASE}/mcp` };
    const attempts: RequestInit[] = [
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fields) },
      { method: "POST", body: new URLSearchParams(fields).toString() },
      { method: "POST", headers: { "Content-Type": "text/plain" }, body: new URLSearchParams(fields).toString() },
      { method: "POST", body: Object.assign(new FormData(), {}) },
    ];
    for (const init of attempts) {
      const response = await api("/token", init);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect(await rows("SELECT * FROM oauth_tokens")).toEqual([]);
  });

  test("errors carry no-store too", async () => {
    const response = await api("/token", form({ grant_type: "x", client_id: CLIENT }));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /token, refresh_token", () => {
  test("rotates both tokens, keeps the family and the earlier access token valid", async () => {
    const first = await exchange();
    const response = await refreshWith(first.refresh_token);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const second = (await response.json()) as Tokens;
    expect(second).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "digest" });
    expect(second.access_token).not.toBe(first.access_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(second.refresh_token.length).toBeGreaterThanOrEqual(32);
    expect(await rows("SELECT DISTINCT family_id FROM oauth_tokens")).toHaveLength(1);
    expect(await checkAccessToken(full(), first.access_token)).not.toBeNull();
    expect(await checkAccessToken(full(), second.access_token)).not.toBeNull();
    const third = await refreshWith(second.refresh_token, { resource: `${BASE}/mcp` });
    expect(third.status).toBe(200);
  });

  test("logs auth.token.issued with the refresh grant", async () => {
    const first = await exchange();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await refreshWith(first.refresh_token);
    expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(`"attrs":{"client_id":"${CLIENT}","grant_type":"refresh_token"}`);
  });

  test("the reuse of a used refresh token gives invalid_grant and revokes the whole family", async () => {
    const first = await exchange();
    const second = (await (await refreshWith(first.refresh_token)).json()) as Tokens;
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reuse = await refreshWith(first.refresh_token);
    expect(reuse.status).toBe(400);
    expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
    for (const token of [first.access_token, second.access_token]) expect(await checkAccessToken(full(), token)).toBeNull();
    const latest = await refreshWith(second.refresh_token);
    expect(latest.status).toBe(400);
    expect(await latest.json()).toMatchObject({ error: "invalid_grant" });
    const lines = spy.mock.calls.map((c) => String(c[0]));
    const event = lines.map((l) => JSON.parse(l) as { event: string; attrs: Record<string, unknown> }).find((l) => l.event === "auth.refresh.reuse_detected");
    expect(event?.attrs).toEqual({ client_id: CLIENT, revoked: 4 });
    expect(lines.join("\n")).not.toContain(first.refresh_token);
  });

  test("the reuse of a refresh token leaves other families alone", async () => {
    const mine = await exchange();
    const other = await exchange();
    await refreshWith(mine.refresh_token);
    await refreshWith(mine.refresh_token);
    expect(await checkAccessToken(full(), other.access_token)).not.toBeNull();
    expect((await refreshWith(other.refresh_token)).status).toBe(200);
  });

  test("an unknown, expired, revoked refresh token and an access token give invalid_grant", async () => {
    const tokens = await exchange();
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ?1 WHERE token_hash = ?2").bind(new Date(Date.now() - 1000).toISOString(), await hex(tokens.refresh_token)).run();
    const fresh = await exchange();
    await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ?1 WHERE token_hash = ?2").bind(new Date().toISOString(), await hex(fresh.refresh_token)).run();
    for (const token of ["unknown-token", tokens.refresh_token, fresh.refresh_token, fresh.access_token]) {
      const response = await refreshWith(token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    }
  });

  test("a refresh token of another client gives invalid_grant and is not used up", async () => {
    const tokens = await exchange();
    const response = await refreshWith(tokens.refresh_token, { client_id: OTHER_CLIENT });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    expect((await refreshWith(tokens.refresh_token)).status).toBe(200);
  });

  test("a wrong resource gives invalid_target and a missing token invalid_request", async () => {
    const tokens = await exchange();
    const wrong = await refreshWith(tokens.refresh_token, { resource: `${BASE}/other` });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: "invalid_target" });
    const missing = await api("/token", form({ grant_type: "refresh_token", client_id: CLIENT }));
    expect(await missing.json()).toMatchObject({ error: "invalid_request" });
    const noClient = await api("/token", form({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
    expect(await noClient.json()).toMatchObject({ error: "invalid_request" });
    expect((await refreshWith(tokens.refresh_token)).status).toBe(200);
  });

  test("an unknown client gives 401 invalid_client", async () => {
    const response = await refreshWith("whatever", { client_id: "nobody" });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });
});

describe("accepting an access token (10.6)", () => {
  const check = (token: string, over: Partial<Env> = {}): ReturnType<typeof checkAccessToken> => checkAccessToken(full(over), token);

  test("a valid access token is accepted", async () => {
    const tokens = await exchange();
    expect(await check(tokens.access_token)).toEqual({ user_sub: "u-bob", email: "bob@test", role: "member", client_id: CLIENT });
  });

  test("an unknown token and an empty one are refused", async () => {
    expect(await check("nope")).toBeNull();
    expect(await check("")).toBeNull();
  });

  test("an expired access token is refused", async () => {
    const tokens = await exchange();
    await env.DB.prepare("UPDATE oauth_tokens SET expires_at = ?1 WHERE kind = 'access'").bind(new Date(Date.now() - 1).toISOString()).run();
    expect(await check(tokens.access_token)).toBeNull();
  });

  test("a revoked access token is refused", async () => {
    const tokens = await exchange();
    await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ?1 WHERE kind = 'access'").bind(new Date().toISOString()).run();
    expect(await check(tokens.access_token)).toBeNull();
  });

  test("a refresh token is refused", async () => {
    const tokens = await exchange();
    expect(await check(tokens.refresh_token)).toBeNull();
  });

  test("a node token is refused", async () => {
    const response = await ops("/ops/nodes", { method: "POST", body: JSON.stringify({ node_id: "n1", owner_label: "x" }) });
    const { token } = (await response.json()) as { token: string };
    expect(await check(token)).toBeNull();
  });

  test("a token for another resource is refused", async () => {
    const tokens = await exchange();
    await env.DB.prepare("UPDATE oauth_tokens SET resource = 'http://worker.test/other'").run();
    expect(await check(tokens.access_token)).toBeNull();
  });

  test("the user is read again on every request: a revoked invite refuses the token at once", async () => {
    const tokens = await exchange();
    expect(await check(tokens.access_token)).not.toBeNull();
    expect((await ops("/ops/invites/revoke", { method: "POST", body: JSON.stringify({ email: "bob@test" }) })).status).toBe(200);
    expect(await check(tokens.access_token)).toBeNull();
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    expect(await check(tokens.access_token)).not.toBeNull();
  });

  test("a user without invite or a missing user row is refused", async () => {
    const tokens = await exchange();
    await env.DB.prepare("DELETE FROM invites").run();
    expect(await check(tokens.access_token)).toBeNull();
    await env.DB.prepare("DELETE FROM users").run();
    expect(await check(tokens.access_token)).toBeNull();
  });

  test("the admin needs no invite, and loses access when ADMIN_EMAIL changes", async () => {
    await env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES ('u-alice', 'alice@test', 'admin', ?1)").bind(new Date().toISOString()).run();
    const response = await api("/token", codeGrant(await newCode({ user: "u-alice" })));
    const tokens = (await response.json()) as Tokens;
    expect(await check(tokens.access_token)).toMatchObject({ email: "alice@test", role: "admin" });
    expect(await check(tokens.access_token, { ADMIN_EMAIL: "someone@test" })).toBeNull();
    expect(await check(tokens.access_token, { ADMIN_EMAIL: undefined })).toBeNull();
  });
});

test("a token is never answered with an unmatched method or path", async () => {
  expect((await api("/token")).status).toBe(404);
});

test("the SHA-256 of tokens is what is stored, not the token", async () => {
  const tokens = await exchange();
  const stored = JSON.stringify(await rows("SELECT * FROM oauth_tokens"));
  expect(stored).not.toContain(tokens.access_token);
  expect(stored).not.toContain(tokens.refresh_token);
});
