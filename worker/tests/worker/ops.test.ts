import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { call, ops, OPS_TOKEN } from "./helpers";

const TABLES = ["nodes", "jobs", "leases", "node_events", "invites", "users", "oauth_clients", "oauth_requests", "oauth_codes", "oauth_tokens"];

async function seed(): Promise<void> {
  const t = "2026-10-16T07:00:00.000Z";
  await env.DB.batch([
    env.DB.prepare("INSERT INTO nodes (node_id, owner_label, token_hash, state_since, created_at) VALUES ('n1', 'o', 'h', ?1, ?1)").bind(t),
    env.DB.prepare("INSERT INTO jobs (video_id, created_at) VALUES ('aaaaaaaaaaa', ?1)").bind(t),
    env.DB.prepare("INSERT INTO leases (lease_id, video_id, node_id, issued_at, expires_at) VALUES ('l1', 'aaaaaaaaaaa', 'n1', ?1, ?1)").bind(t),
    env.DB.prepare("INSERT INTO node_events (node_id, ts, kind) VALUES ('n1', ?1, 'job_ok')").bind(t),
    env.DB.prepare("INSERT INTO invites (email, invited_at) VALUES ('bob@test', ?1)").bind(t),
    env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES ('s1', 'bob@test', 'member', ?1)").bind(t),
    env.DB.prepare("INSERT INTO oauth_clients (client_id, redirect_uris, created_at) VALUES ('c1', '[]', ?1)").bind(t),
    env.DB.prepare("INSERT INTO oauth_requests (request_id, client_id, redirect_uri, code_challenge, scope, resource, expires_at) VALUES ('r1', 'c1', 'u', 'x', 'digest', 'r', ?1)").bind(t),
    env.DB.prepare("INSERT INTO oauth_codes (code_hash, client_id, user_sub, redirect_uri, code_challenge, scope, resource, expires_at) VALUES ('h1', 'c1', 's1', 'u', 'x', 'digest', 'r', ?1)").bind(t),
    env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, family_id, scope, resource, expires_at) VALUES ('h2', 'access', 'c1', 's1', 'f', 'digest', 'r', ?1)").bind(t),
  ]);
}

const count = async (table: string): Promise<number> =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? -1;

describe("operator authentication", () => {
  const routes: [string, string][] = [
    ["POST", "/ops/reset"],
    ["GET", "/ops/users"],
    ["POST", "/ops/nodes"],
    ["GET", "/ops/unknown"],
  ];

  test.each(routes)("%s %s without bearer gives 401 unauthorized", async (method, path) => {
    const response = await call(path, { method, body: method === "POST" ? "{not json" : undefined });
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  test.each(["wrong", `${OPS_TOKEN}x`, OPS_TOKEN.slice(0, -1), ""])("a wrong bearer %j gives 401 whatever the body", async (token) => {
    for (const body of [undefined, "{}", "{not json", JSON.stringify({ node_id: "!" })]) {
      const response = await call("/ops/reset", { method: "POST", body, headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(401);
    }
  });

  test("another authorization scheme gives 401", async () => {
    const response = await call("/ops/reset", { method: "POST", headers: { Authorization: `Basic ${OPS_TOKEN}` } });
    expect(response.status).toBe(401);
  });

  test("a rejected request changes nothing", async () => {
    await seed();
    await call("/ops/reset", { method: "POST" });
    expect(await count("nodes")).toBe(1);
    await ops("/ops/reset", { method: "POST" });
  });

  test.each([undefined, ""])("OPS_TOKEN %j makes every /ops/* request 404, bearer or not", async (value) => {
    const settings = value === undefined ? {} : { OPS_TOKEN: value };
    const bearers: Record<string, string>[] = [{}, { Authorization: "Bearer " }, { Authorization: `Bearer ${OPS_TOKEN}` }];
    for (const headers of bearers) {
      for (const path of ["/ops/reset", "/ops/users", "/ops/unknown"]) {
        const response = await call(path, { method: "POST", headers }, settings);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
      }
    }
  });

  test("an unknown /ops route or method behind a valid bearer gives 404", async () => {
    expect((await ops("/ops/unknown")).status).toBe(404);
    expect((await ops("/ops/reset")).status).toBe(404);
  });
});

describe("POST /ops/reset", () => {
  test("empties every table and every object under transcripts/", async () => {
    await seed();
    await env.TRANSCRIPTS.put("transcripts/aaaaaaaaaaa.json", "{}");
    await env.TRANSCRIPTS.put("transcripts/bbbbbbbbbbb.json", "{}");
    await env.TRANSCRIPTS.put("other/keep.json", "{}");
    for (const table of TABLES) {
      expect(await count(table), table).toBeGreaterThan(0);
    }

    const response = await ops("/ops/reset", { method: "POST" });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    for (const table of TABLES) {
      expect(await count(table), table).toBe(0);
    }
    expect((await env.TRANSCRIPTS.list({ prefix: "transcripts/" })).objects).toEqual([]);
    expect(await env.TRANSCRIPTS.head("other/keep.json")).not.toBeNull();
    await env.TRANSCRIPTS.delete("other/keep.json");
  });

  test("removes more objects than one R2 listing page holds", async () => {
    await Promise.all(Array.from({ length: 1100 }, (_, i) => env.TRANSCRIPTS.put(`transcripts/v${i}.json`, "{}")));
    await ops("/ops/reset", { method: "POST" });
    expect((await env.TRANSCRIPTS.list({ prefix: "transcripts/" })).objects).toEqual([]);
  });
});

describe("invites", () => {
  const post = (path: string, body: unknown): Promise<Response> => ops(path, { method: "POST", body: JSON.stringify(body) });
  const invite = async (email: string): Promise<{ email: string; invited_at: string; revoked: number } | null> =>
    env.DB.prepare("SELECT email, invited_at, revoked FROM invites WHERE email = ?1").bind(email).first();

  test("an invite is stored lowercased", async () => {
    await ops("/ops/reset", { method: "POST" });
    const response = await post("/ops/invites", { email: "Bob@Test" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ email: "bob@test", revoked: false });
    expect(await invite("bob@test")).toMatchObject({ email: "bob@test", revoked: 0 });
    expect(await invite("Bob@Test")).toBeNull();
  });

  test("inviting again re-activates a revoked invite", async () => {
    await ops("/ops/reset", { method: "POST" });
    await post("/ops/invites", { email: "bob@test" });
    const revoked = await post("/ops/invites/revoke", { email: "BOB@test" });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ email: "bob@test", revoked: true });
    expect(await invite("bob@test")).toMatchObject({ revoked: 1 });

    const again = await post("/ops/invites", { email: "bob@test" });
    expect(await again.json()).toEqual({ email: "bob@test", revoked: false });
    expect(await invite("bob@test")).toMatchObject({ revoked: 0 });
    expect(await count("invites")).toBe(1);
  });

  test("revoking an unknown invite gives 404 not_found", async () => {
    await ops("/ops/reset", { method: "POST" });
    const response = await post("/ops/invites/revoke", { email: "nobody@test" });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test.each([{}, { email: 1 }, { email: "no-at" }, { email: "a@b", extra: 1 }])("a bad body %j gives 400 invalid_request", async (body) => {
    for (const path of ["/ops/invites", "/ops/invites/revoke"]) {
      const response = await post(path, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    }
    expect((await ops("/ops/invites", { method: "POST", body: "{not json" })).status).toBe(400);
  });
});

describe("GET /ops/users", () => {
  test("lists users sorted by e-mail", async () => {
    await ops("/ops/reset", { method: "POST" });
    const t = "2026-10-16T07:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (user_sub, email, role, google_refresh_token_enc, created_at) VALUES ('s2', 'bob@test', 'member', 'secret', ?1)").bind(t),
      env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES ('s1', 'alice@test', 'admin', ?1)").bind(t),
      env.DB.prepare("INSERT INTO users (user_sub, email, role, created_at) VALUES ('s3', 'carol@test', 'member', ?1)").bind(t),
    ]);
    const response = await ops("/ops/users");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      users: [
        { user_sub: "s1", email: "alice@test", role: "admin" },
        { user_sub: "s2", email: "bob@test", role: "member" },
        { user_sub: "s3", email: "carol@test", role: "member" },
      ],
    });
  });

  test("is an empty list without users", async () => {
    await ops("/ops/reset", { method: "POST" });
    expect(await (await ops("/ops/users")).json()).toEqual({ users: [] });
  });
});
