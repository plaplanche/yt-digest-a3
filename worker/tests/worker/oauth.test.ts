import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { call, ops } from "./helpers";
import type { Env } from "../../src/env";

const BASE = "http://worker.test";
const ISSUER = "http://google.test";
const REDIRECT = "http://127.0.0.1:9/cb";
const GOOGLE_REFRESH = "google-refresh-secret-value";
const settings: Partial<Env> = {
  OPS_TOKEN: "ops-test",
  PUBLIC_URL: BASE,
  GOOGLE_ISSUER: ISSUER,
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-secret",
  ADMIN_EMAIL: "alice@test",
  TOKEN_ENC_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  AUTH_REQUEST_TTL_SECONDS: "600",
};
const api = (path: string, init: RequestInit = {}, over: Partial<Env> = {}): Promise<Response> => call(path, { redirect: "manual", ...init }, { ...settings, ...over });

const b64url = (data: ArrayBuffer | Uint8Array | string): string =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// The stub plays Google's discovery, token and JWKS endpoints with real RS256 signatures.
interface Stub {
  email: string;
  verified: boolean;
  aud: string;
  iss: string;
  nonce: string | null;
  expIn: number;
  signWithOtherKey: boolean;
  tokenStatus: number;
  tokenRequests: URLSearchParams[];
}
let keys: CryptoKeyPair;
let otherKeys: CryptoKeyPair;
let stub: Stub;

beforeAll(async () => {
  const params = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  keys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  otherKeys = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
});

async function idToken(): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const claims = { iss: stub.iss, aud: stub.aud, sub: `g-${stub.email}`, email: stub.email, email_verified: stub.verified, iat, exp: iat + stub.expIn, ...(stub.nonce === null ? {} : { nonce: stub.nonce }) };
  const input = `${b64url(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", (stub.signWithOtherKey ? otherKeys : keys).privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(signature)}`;
}

beforeEach(async () => {
  await ops("/ops/reset", { method: "POST" });
  stub = { email: "bob@test", verified: true, aud: "google-client", iss: ISSUER, nonce: null, expIn: 3600, signWithOtherKey: false, tokenStatus: 200, tokenRequests: [] };
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(ISSUER)) return realFetch(input, init);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url.endsWith("/jwks")) {
      return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] });
    }
    if (url.endsWith("/token")) {
      stub.tokenRequests.push(new URLSearchParams(String(init?.body)));
      if (stub.tokenStatus !== 200) return Response.json({ error: "invalid_grant" }, { status: stub.tokenStatus });
      return Response.json({ access_token: "g-access", token_type: "Bearer", id_token: await idToken(), refresh_token: GOOGLE_REFRESH });
    }
    return new Response("not found", { status: 404 });
  });
});
afterEach(() => vi.restoreAllMocks());

async function register(body: unknown = { redirect_uris: [REDIRECT], client_name: "Test client" }): Promise<{ client_id: string }> {
  const response = await api("/register", { method: "POST", body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return (await response.json()) as { client_id: string };
}

const authorizeUrl = (clientId: string, over: Record<string, string | null> = {}): string => {
  const params: Record<string, string | null> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: "challenge-value",
    code_challenge_method: "S256",
    resource: `${BASE}/mcp`,
    state: "client-state",
    ...over,
  };
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) if (value !== null) query.set(name, value);
  return `/authorize?${query.toString()}`;
};

const hidden = (html: string): string => /name="request" value="([^"]+)"/.exec(html)?.[1] ?? "";
const consentForm = (request: string, decision: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ request, decision }).toString(),
});

async function pending(clientId: string): Promise<string> {
  const response = await api(authorizeUrl(clientId));
  expect(response.status).toBe(200);
  return hidden(await response.text());
}

/** Runs the flow up to Google's redirect; returns the state and nonce sent to Google. */
async function approve(clientId: string): Promise<{ state: string; nonce: string }> {
  const response = await api("/authorize/consent", consentForm(await pending(clientId), "approve"));
  expect(response.status).toBe(302);
  const url = new URL(response.headers.get("Location") ?? "");
  stub.nonce = url.searchParams.get("nonce");
  return { state: url.searchParams.get("state") ?? "", nonce: url.searchParams.get("nonce") ?? "" };
}

const rows = async (sql: string): Promise<Record<string, unknown>[]> => (await env.DB.prepare(sql).all<Record<string, unknown>>()).results;

describe("discovery", () => {
  test("the protected resource document, at both paths", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const response = await api(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ resource: `${BASE}/mcp`, authorization_servers: [BASE], scopes_supported: ["digest"], bearer_methods_supported: ["header"] });
    }
  });

  test("the authorization server document", async () => {
    const response = await api("/.well-known/oauth-authorization-server");
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["digest"],
    });
  });

  test("a trailing slash in PUBLIC_URL is dropped", async () => {
    const response = await api("/.well-known/oauth-protected-resource", {}, { PUBLIC_URL: `${BASE}/` });
    expect(((await response.json()) as { resource: string }).resource).toBe(`${BASE}/mcp`);
  });
});

describe("POST /register", () => {
  const post = (body: unknown): Promise<Response> => api("/register", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

  test("registers a public client", async () => {
    const before = Math.floor(Date.now() / 1000);
    const response = await post({ redirect_uris: [REDIRECT, "https://app.example/cb?x=1", "http://localhost:3000/cb"], client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      client_name: "Claude",
      redirect_uris: [REDIRECT, "https://app.example/cb?x=1", "http://localhost:3000/cb"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
    expect((body.client_id as string).length).toBeGreaterThanOrEqual(16);
    expect(body.client_id_issued_at).toBeGreaterThanOrEqual(before);
    expect(body).not.toHaveProperty("client_secret");
    expect(await rows("SELECT client_id, client_name FROM oauth_clients")).toEqual([{ client_id: body.client_id, client_name: "Claude" }]);
  });

  test("client_name is omitted from the answer when not given, and ids differ", async () => {
    const a = (await (await post({ redirect_uris: [REDIRECT] })).json()) as Record<string, unknown>;
    const b = (await (await post({ redirect_uris: [REDIRECT] })).json()) as Record<string, unknown>;
    expect(a).not.toHaveProperty("client_name");
    expect(a.client_id).not.toBe(b.client_id);
  });

  test.each([
    ["missing", {}],
    ["empty", { redirect_uris: [] }],
    ["not an array", { redirect_uris: REDIRECT }],
    ["http on another host", { redirect_uris: ["http://example.com/cb"] }],
    ["relative", { redirect_uris: ["/cb"] }],
    ["not a URL", { redirect_uris: ["nope"] }],
    ["a fragment", { redirect_uris: ["https://app.example/cb#x"] }],
    ["another scheme", { redirect_uris: ["myapp://cb"] }],
    ["one invalid among valid", { redirect_uris: [REDIRECT, "ftp://x/y"] }],
    ["a non-string", { redirect_uris: [REDIRECT, 3] }],
  ])("redirect_uris %s gives invalid_redirect_uri", async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test.each([
    ["client_name too long", { client_name: "x".repeat(201) }],
    ["client_name not a string", { client_name: 4 }],
    ["token_endpoint_auth_method", { token_endpoint_auth_method: "client_secret_basic" }],
    ["grant_types", { grant_types: ["password"] }],
    ["grant_types not an array", { grant_types: "authorization_code" }],
    ["response_types", { response_types: ["token"] }],
    ["more than 10 redirect URIs", { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) }],
  ])("%s gives invalid_client_metadata", async (_name, extra) => {
    const response = await post({ redirect_uris: [REDIRECT], ...extra });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  test("a body that is not a JSON object gives invalid_client_metadata", async () => {
    for (const body of ["{nope", "[]", "3"]) {
      expect(await (await post(body)).json()).toMatchObject({ error: "invalid_client_metadata" });
    }
  });

  test("a client_name of 200 characters and 10 redirect URIs pass", async () => {
    const response = await post({ redirect_uris: Array.from({ length: 10 }, (_, i) => `https://a.example/${i}`), client_name: "x".repeat(200) });
    expect(response.status).toBe(201);
  });

  test("logs auth.client.registered with the client id and nothing else", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client_id } = await register();
    const lines = spy.mock.calls.map((c) => JSON.parse(String(c[0])) as { event: string; attrs: unknown });
    expect(lines).toContainEqual(expect.objectContaining({ event: "auth.client.registered", attrs: { client_id } }));
  });
});

describe("GET /authorize", () => {
  test.each([
    ["an unknown client", (id: string) => authorizeUrl(`${id}x`)],
    ["a missing client_id", () => authorizeUrl("x", { client_id: null })],
    ["a missing redirect_uri", (id: string) => authorizeUrl(id, { redirect_uri: null })],
    ["a redirect_uri that is only a prefix", (id: string) => authorizeUrl(id, { redirect_uri: `${REDIRECT}/more` })],
    ["a redirect_uri with another case", (id: string) => authorizeUrl(id, { redirect_uri: REDIRECT.toUpperCase() })],
    ["an unregistered redirect_uri, even with other errors", (id: string) => authorizeUrl(id, { redirect_uri: "https://evil.example/cb", response_type: "token" })],
  ])("%s gives a 400 HTML page and never a redirect", async (_name, build) => {
    const { client_id } = await register();
    const response = await api(build(client_id));
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(await rows("SELECT * FROM oauth_requests")).toEqual([]);
  });

  const redirected = async (over: Record<string, string | null>): Promise<URL> => {
    const { client_id } = await register();
    const response = await api(authorizeUrl(client_id, over));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(await rows("SELECT * FROM oauth_requests")).toEqual([]);
    return location;
  };

  test.each([
    ["response_type token", { response_type: "token" }, "unsupported_response_type"],
    ["response_type missing", { response_type: null }, "unsupported_response_type"],
    ["code_challenge missing", { code_challenge: null }, "invalid_request"],
    ["code_challenge_method plain", { code_challenge_method: "plain" }, "invalid_request"],
    ["code_challenge_method absent", { code_challenge_method: null }, "invalid_request"],
    ["resource missing", { resource: null }, "invalid_target"],
    ["resource not exact", { resource: `${BASE}/mcp/` }, "invalid_target"],
    ["resource of another host", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["scope admin", { scope: "admin" }, "invalid_scope"],
    ["scope digest and admin", { scope: "digest admin" }, "invalid_scope"],
  ])("%s redirects with %s", async (_name, over, code) => {
    const location = await redirected(over);
    expect(location.searchParams.get("error")).toBe(code);
    expect(location.searchParams.get("state")).toBe("client-state");
  });

  test("the errors are checked in order", async () => {
    const all = { response_type: "token", code_challenge: null, resource: null, scope: "admin" };
    expect((await redirected(all)).searchParams.get("error")).toBe("unsupported_response_type");
    expect((await redirected({ code_challenge: null, resource: null, scope: "admin" })).searchParams.get("error")).toBe("invalid_request");
    expect((await redirected({ resource: null, scope: "admin" })).searchParams.get("error")).toBe("invalid_target");
    expect((await redirected({ scope: "admin" })).searchParams.get("error")).toBe("invalid_scope");
  });

  test("an error redirect without state carries no state, and keeps the query of the redirect URI", async () => {
    const { client_id } = await register({ redirect_uris: ["https://app.example/cb?keep=1"] });
    const response = await api(authorizeUrl(client_id, { redirect_uri: "https://app.example/cb?keep=1", state: null, response_type: "token" }));
    const location = new URL(response.headers.get("Location") ?? "");
    expect(location.searchParams.get("keep")).toBe("1");
    expect(location.searchParams.get("error")).toBe("unsupported_response_type");
    expect(location.searchParams.has("state")).toBe(false);
  });

  test("a valid request shows the consent page and stores the pending authorization", async () => {
    const { client_id } = await register();
    const response = await api(authorizeUrl(client_id));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("Test client");
    expect(html).toContain(REDIRECT);
    expect(html).toContain("digest");
    expect(html).toMatch(/<form method="post" action="\/authorize\/consent">/);
    expect(html.match(/<button type="submit" name="decision" value="(approve|deny)">/g)).toHaveLength(2);
    const id = hidden(html);
    expect(id.length).toBeGreaterThanOrEqual(16);
    const [row] = await rows("SELECT * FROM oauth_requests");
    expect(row).toMatchObject({ request_id: id, client_id, redirect_uri: REDIRECT, client_state: "client-state", code_challenge: "challenge-value", scope: "digest", resource: `${BASE}/mcp`, google_state: null, used_at: null });
    expect(Date.parse(String(row?.expires_at)) - Date.now()).toBeGreaterThan(590_000);
  });

  test("the scope defaults to digest and each request has its own id", async () => {
    const { client_id } = await register();
    expect(await pending(client_id)).not.toBe(await pending(client_id));
    expect(await rows("SELECT scope FROM oauth_requests")).toEqual([{ scope: "digest" }, { scope: "digest" }]);
  });

  test("the client name and the redirect URI are escaped; a nameless client shows its id", async () => {
    const evil = "<script>alert(1)</script>&\"'";
    const named = await register({ redirect_uris: ["https://app.example/cb?a=1&b=<x>"], client_name: evil });
    const html = await (await api(authorizeUrl(named.client_id, { redirect_uri: "https://app.example/cb?a=1&b=<x>" }))).text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;");
    expect(html).toContain("a=1&amp;b=&lt;x&gt;");
    const nameless = await register({ redirect_uris: [REDIRECT] });
    expect(await (await api(authorizeUrl(nameless.client_id))).text()).toContain(nameless.client_id);
  });
});

describe("POST /authorize/consent", () => {
  test("deny uses the request up and redirects with access_denied and the state", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await api("/authorize/consent", consentForm(id, "deny"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe("client-state");
    expect((await rows("SELECT used_at FROM oauth_requests"))[0]?.used_at).not.toBeNull();
    expect(spy.mock.calls.map((c) => JSON.parse(String(c[0])) as unknown)).toContainEqual(expect.objectContaining({ event: "auth.oauth.denied", attrs: { client_id, reason: "access_denied" } }));
    for (const decision of ["deny", "approve"]) {
      expect((await api("/authorize/consent", consentForm(id, decision))).status).toBe(400);
    }
  });

  test("approve redirects to Google with every parameter", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    const response = await api("/authorize/consent", consentForm(id, "approve"));
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(`${ISSUER}/authorize`);
    const q = location.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      client_id: "google-client",
      redirect_uri: `${BASE}/callback`,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/youtube.readonly",
      state: q.get("state"),
      nonce: q.get("nonce"),
      access_type: "offline",
      prompt: "consent",
    });
    expect((q.get("state") ?? "").length).toBeGreaterThanOrEqual(16);
    expect((q.get("nonce") ?? "").length).toBeGreaterThanOrEqual(16);
    expect(q.get("state")).not.toBe(id);
    expect(await rows("SELECT google_state, google_nonce, used_at FROM oauth_requests")).toEqual([{ google_state: q.get("state"), google_nonce: q.get("nonce"), used_at: null }]);
  });

  test("approving twice is refused and the first state stays the only one", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    const first = await api("/authorize/consent", consentForm(id, "approve"));
    expect(first.status).toBe(302);
    expect((await api("/authorize/consent", consentForm(id, "approve"))).status).toBe(400);
    expect((await api("/authorize/consent", consentForm(id, "deny"))).status).toBe(302);
  });

  test.each([
    ["unknown", () => "nope"],
    ["missing", () => ""],
  ])("an %s request gives 400 HTML", async (_name, id) => {
    for (const decision of ["approve", "deny"]) {
      const response = await api("/authorize/consent", consentForm(id(), decision));
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Type")).toContain("text/html");
      expect(response.headers.get("Location")).toBeNull();
    }
  });

  test("an expired request gives 400 HTML and no redirect", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    await env.DB.prepare("UPDATE oauth_requests SET expires_at = ?1").bind(new Date(Date.now() - 1000).toISOString()).run();
    for (const decision of ["approve", "deny"]) {
      const response = await api("/authorize/consent", consentForm(id, decision));
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
    }
  });

  test("an unknown decision gives 400 and leaves the request usable", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    expect((await api("/authorize/consent", consentForm(id, "maybe"))).status).toBe(400);
    expect((await api("/authorize/consent", consentForm(id, "approve"))).status).toBe(302);
  });

  test("approve answers 502 when Google is unreachable and keeps the request", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    vi.mocked(globalThis.fetch).mockImplementation(async () => new Response("down", { status: 500 }));
    expect((await api("/authorize/consent", consentForm(id, "approve"))).status).toBe(502);
    expect((await rows("SELECT google_state FROM oauth_requests"))[0]?.google_state).toBeNull();
  });
});

describe("GET /callback", () => {
  const callbackUrl = (state: string, extra: Record<string, string> = {}): string => `/callback?${new URLSearchParams({ state, code: "google-code", ...extra }).toString()}`;
  const sub = (email: string): string => `g-${email}`;

  async function login(email: string, over: Partial<Stub> = {}): Promise<{ response: Response; clientId: string }> {
    const { client_id } = await register();
    const { state } = await approve(client_id);
    stub.email = email;
    Object.assign(stub, over);
    return { response: await api(callbackUrl(state)), clientId: client_id };
  }

  const location = (response: Response): URL => new URL(response.headers.get("Location") ?? "");

  test("an invited user gets a code bound to the request, a users row and the invite is accepted", async () => {
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "Bob@Test" }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, clientId } = await login("bob@test");
    expect(response.status).toBe(302);
    const url = location(response);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe("client-state");
    const code = url.searchParams.get("code") ?? "";
    expect(code.length).toBeGreaterThanOrEqual(32);
    expect(await rows("SELECT user_sub, email, role FROM users")).toEqual([{ user_sub: sub("bob@test"), email: "bob@test", role: "member" }]);
    expect(await rows("SELECT accepted_user_sub FROM invites")).toEqual([{ accepted_user_sub: sub("bob@test") }]);
    const [row] = await rows("SELECT * FROM oauth_codes");
    expect(row).toMatchObject({ client_id: clientId, user_sub: sub("bob@test"), redirect_uri: REDIRECT, code_challenge: "challenge-value", scope: "digest", resource: `${BASE}/mcp`, used_at: null });
    expect(row?.code_hash).not.toBe(code);
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const ttl = Date.parse(String(row?.expires_at)) - Date.now();
    expect(ttl).toBeGreaterThan(50_000);
    expect(ttl).toBeLessThanOrEqual(60_000);
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines.map((l) => JSON.parse(l) as unknown)).toContainEqual(expect.objectContaining({ event: "auth.oauth.completed", attrs: { client_id: clientId, role: "member" } }));
    for (const line of lines) {
      for (const secret of [code, GOOGLE_REFRESH, "bob@test", sub("bob@test")]) expect(line).not.toContain(secret);
    }
    // the pending authorization is used up, and the Google code exchange carried the secret in the body
    expect((await rows("SELECT used_at FROM oauth_requests"))[0]?.used_at).not.toBeNull();
    expect(Object.fromEntries(stub.tokenRequests[0] ?? [])).toEqual({ grant_type: "authorization_code", code: "google-code", redirect_uri: `${BASE}/callback`, client_id: "google-client", client_secret: "google-secret" });
  });

  test("the admin needs no invite and gets the admin role", async () => {
    const { response } = await login("alice@test");
    expect(response.status).toBe(302);
    expect(location(response).searchParams.has("code")).toBe(true);
    expect(await rows("SELECT email, role FROM users")).toEqual([{ email: "alice@test", role: "admin" }]);
  });

  test("a second login updates the row and keeps the refresh token when Google sends none", async () => {
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    await login("bob@test");
    const [first] = await rows("SELECT google_refresh_token_enc FROM users");
    const { client_id } = await register();
    const { state } = await approve(client_id);
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => new Response("x", { status: 500 }));
    await api(callbackUrl(state));
    await login("bob@test");
    expect(await rows("SELECT COUNT(*) AS n FROM users")).toEqual([{ n: 1 }]);
    expect((await rows("SELECT google_refresh_token_enc FROM users"))[0]?.google_refresh_token_enc).toMatch(/^v1:/);
    expect(first?.google_refresh_token_enc).toMatch(/^v1:/);
  });

  test("the Google refresh token is stored encrypted and appears in no stored value", async () => {
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    await login("bob@test");
    const [row] = await rows("SELECT google_refresh_token_enc AS enc FROM users");
    const enc = String(row?.enc);
    expect(enc).toMatch(/^v1:[A-Za-z0-9+/]+=*$/);
    const raw = Uint8Array.from(atob(enc.slice(3)), (c) => c.charCodeAt(0));
    expect(raw.length).toBe(12 + GOOGLE_REFRESH.length + 16);
    const key = await crypto.subtle.importKey("raw", new Uint8Array(32), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: raw.slice(0, 12) }, key, raw.slice(12));
    expect(new TextDecoder().decode(plain)).toBe(GOOGLE_REFRESH);
    for (const table of ["nodes", "jobs", "leases", "node_events", "invites", "users", "oauth_clients", "oauth_requests", "oauth_codes", "oauth_tokens"]) {
      expect(JSON.stringify(await rows(`SELECT * FROM ${table}`))).not.toContain(GOOGLE_REFRESH);
    }
    // two encryptions of the same value differ (random IV)
    const { encryptSecret } = await import("../../src/tokens");
    expect(await encryptSecret("x", settings.TOKEN_ENC_KEY ?? "")).not.toBe(await encryptSecret("x", settings.TOKEN_ENC_KEY ?? ""));
  });

  test.each([
    ["not invited", "mallory@test", {}, "not_invited"],
    ["an invite revoked", "bob@test", {}, "not_invited"],
    ["an unverified e-mail (invited)", "bob@test", { verified: false }, "email_unverified"],
    ["an unverified e-mail (admin)", "alice@test", { verified: false }, "email_unverified"],
  ])("%s gets the 403 page and no row", async (name, email, over, reason) => {
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    if (name === "an invite revoked") await ops("/ops/invites/revoke", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, clientId } = await login(email, over);
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("<title>Access refused</title>");
    expect(html).toContain("This account is not invited.");
    expect(await rows("SELECT * FROM users")).toEqual([]);
    expect(await rows("SELECT * FROM oauth_codes")).toEqual([]);
    expect(spy.mock.calls.map((c) => JSON.parse(String(c[0])) as unknown)).toContainEqual(expect.objectContaining({ event: "auth.oauth.denied", attrs: { client_id: clientId, reason } }));
  });

  test.each([
    ["a bad signature", { signWithOtherKey: true }],
    ["a wrong aud", { aud: "someone-else" }],
    ["a wrong iss", { iss: "http://evil.test" }],
    ["an expired token", { expIn: -10 }],
  ])("%s gives server_error and no row", async (_name, over) => {
    const { response, clientId } = await login("alice@test", over);
    expect(response.status).toBe(302);
    expect(location(response).searchParams.get("error")).toBe("server_error");
    expect(location(response).searchParams.get("state")).toBe("client-state");
    expect(location(response).searchParams.has("code")).toBe(false);
    expect(await rows("SELECT * FROM users")).toEqual([]);
    expect(await rows("SELECT * FROM oauth_codes")).toEqual([]);
    expect(clientId).toBeTruthy();
  });

  test.each([
    ["a wrong nonce", "other-nonce"],
    ["no nonce", null],
  ])("%s gives server_error", async (_name, nonce) => {
    const { client_id } = await register();
    const { state } = await approve(client_id);
    stub.email = "alice@test";
    stub.nonce = nonce;
    const response = await api(callbackUrl(state));
    expect(location(response).searchParams.get("error")).toBe("server_error");
    expect(await rows("SELECT * FROM users")).toEqual([]);
  });

  test("a token endpoint failure and a missing code give server_error", async () => {
    expect(location((await login("alice@test", { tokenStatus: 400 })).response).searchParams.get("error")).toBe("server_error");
    const { client_id } = await register();
    const { state } = await approve(client_id);
    const response = await api(`/callback?state=${state}`);
    expect(location(response).searchParams.get("error")).toBe("server_error");
  });

  test("an error from Google redirects to the client with access_denied", async () => {
    const { client_id } = await register();
    const { state } = await approve(client_id);
    const response = await api(`/callback?${new URLSearchParams({ state, error: "access_denied" }).toString()}`);
    expect(response.status).toBe(302);
    expect(location(response).searchParams.get("error")).toBe("access_denied");
    expect(location(response).searchParams.get("state")).toBe("client-state");
    expect(stub.tokenRequests).toEqual([]);
    expect((await api(callbackUrl(state))).status).toBe(400);
    expect(client_id).toBeTruthy();
  });

  test.each([
    ["no state", () => "/callback?code=x"],
    ["an empty state", () => "/callback?state=&code=x"],
    ["an unknown state", () => callbackUrl("unknown-state")],
  ])("%s gives 400 HTML and no exchange", async (_name, url) => {
    const { client_id } = await register();
    await approve(client_id);
    const response = await api(url());
    expect(response.status).toBe(400);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(stub.tokenRequests).toEqual([]);
    // the pending authorization is still usable
    expect((await rows("SELECT used_at FROM oauth_requests"))[0]?.used_at).toBeNull();
  });

  test("the client's own request id is not a state", async () => {
    const { client_id } = await register();
    const id = await pending(client_id);
    await api("/authorize/consent", consentForm(id, "approve"));
    expect((await api(callbackUrl(id))).status).toBe(400);
  });

  test("a state is single use, even when the first callback failed", async () => {
    const { client_id } = await register();
    const { state } = await approve(client_id);
    stub.email = "mallory@test";
    expect((await api(callbackUrl(state))).status).toBe(403);
    stub.email = "alice@test";
    expect((await api(callbackUrl(state))).status).toBe(400);
    expect(await rows("SELECT * FROM users")).toEqual([]);
  });

  test("an expired state gives 400", async () => {
    const { client_id } = await register();
    const { state } = await approve(client_id);
    await env.DB.prepare("UPDATE oauth_requests SET expires_at = ?1").bind(new Date(Date.now() - 1000).toISOString()).run();
    stub.email = "alice@test";
    expect((await api(callbackUrl(state))).status).toBe(400);
    expect(stub.tokenRequests).toEqual([]);
  });

  test("a revoked invite does not let the user in, a re-invite does", async () => {
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    await ops("/ops/invites/revoke", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    expect((await login("bob@test")).response.status).toBe(403);
    await ops("/ops/invites", { method: "POST", body: JSON.stringify({ email: "bob@test" }) });
    expect((await login("bob@test")).response.status).toBe(302);
  });
});
