import { createHash, createPublicKey, verify } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { APIRequestContext, APIResponse } from "@playwright/test";
import { mocksUrl } from "./stack";

const issuer = `${mocksUrl}/google`;
const clientId = "yt-digest-local";
const clientSecret = "local-google-secret";
const redirectUri = "http://127.0.0.1:9/callback";

const authorizeParams = (extra: Record<string, string> = {}): URLSearchParams =>
  new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: "openid email", ...extra });

const authorize = (request: APIRequestContext, params: URLSearchParams): Promise<APIResponse> =>
  request.get(`${issuer}/authorize?${params.toString()}`, { maxRedirects: 0 });

const token = (request: APIRequestContext, form: Record<string, string>, headers: Record<string, string> = {}): Promise<APIResponse> =>
  request.post(`${issuer}/token`, { form, headers });

async function login(request: APIRequestContext, email: string, extra: Record<string, string> = {}): Promise<string> {
  const response = await authorize(request, authorizeParams({ login_hint: email, ...extra }));
  expect(response.status()).toBe(302);
  const code = new URL(response.headers().location ?? "").searchParams.get("code");
  expect(code).not.toBeNull();
  return code ?? "";
}

const exchange = (request: APIRequestContext, code: string): Promise<APIResponse> =>
  token(request, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret });

const decode = (part: string): Record<string, unknown> => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;

test("the discovery document describes the Google routes", async ({ request }) => {
  const response = await request.get(`${issuer}/.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
});

test("authorize refuses a wrong client, a missing parameter or a scope without openid", async ({ request }) => {
  for (const params of [
    authorizeParams({ client_id: "other" }),
    authorizeParams({ scope: "email profile" }),
    authorizeParams({ scope: "openidx" }),
    authorizeParams({ response_type: "token" }),
    new URLSearchParams({ client_id: clientId, response_type: "code", scope: "openid" }),
  ]) {
    expect((await authorize(request, params)).status(), params.toString()).toBe(400);
  }
});

test("authorize shows a sign-in form that repeats every parameter", async ({ request }) => {
  const params = authorizeParams({ state: "s&1\"<x>", nonce: "n1", access_type: "offline" });
  const response = await authorize(request, params);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
  const html = await response.text();
  expect(html).toMatch(/<form method="get" action="\/google\/authorize">/);
  expect(html).toMatch(/<input type="text" name="login_hint">/);
  expect(html).toMatch(/<button type="submit">/);
  for (const [name, value] of params) {
    const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    expect(html).toContain(`<input type="hidden" name="${name}" value="${escaped}">`);
  }
});

test("authorize with a login_hint redirects with a code and the state", async ({ request }) => {
  const response = await authorize(request, authorizeParams({ login_hint: "Bob@Test", state: "abc 123" }));
  expect(response.status()).toBe(302);
  const location = new URL(response.headers().location ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get("state")).toBe("abc 123");
  expect(location.searchParams.get("code")).toBeTruthy();
});

test("the code gives an ID token signed with the JWKS key and the claims of 5.3", async ({ request }) => {
  const before = Math.floor(Date.now() / 1000);
  const code = await login(request, "Bob@Test", { nonce: "nonce-1" });
  const response = await exchange(request, code);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "openid email" });
  expect(typeof body.access_token).toBe("string");
  expect(body.refresh_token).toBeUndefined();

  const [header, payload, signature] = String(body.id_token).split(".");
  expect(decode(header ?? "")).toMatchObject({ alg: "RS256" });

  const jwks = (await (await request.get(`${issuer}/jwks`)).json()) as { keys: (Record<string, unknown> & { kid: string })[] };
  expect(jwks.keys).toHaveLength(1);
  const key = jwks.keys[0];
  expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
  expect(decode(header ?? "").kid).toBe(key?.kid);
  const publicKey = createPublicKey({ key: key as never, format: "jwk" });
  expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);

  const claims = decode(payload ?? "");
  const iat = claims.iat as number;
  expect(claims).toEqual({
    iss: issuer,
    aud: clientId,
    sub: `g-${createHash("sha256").update("bob@test").digest("hex").slice(0, 16)}`,
    email: "bob@test",
    email_verified: true,
    iat,
    exp: iat + 3600,
    nonce: "nonce-1",
  });
  expect(iat).toBeGreaterThanOrEqual(before);
  expect(iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
});

test("the ID token has no nonce when the request had none", async ({ request }) => {
  const body = (await (await exchange(request, await login(request, "bob@test"))).json()) as { id_token: string };
  expect(decode(body.id_token.split(".")[1] ?? "")).not.toHaveProperty("nonce");
});

test("a code is single use and bound to its redirect_uri", async ({ request }) => {
  const code = await login(request, "bob@test");
  expect((await exchange(request, code)).status()).toBe(200);
  const again = await exchange(request, code);
  expect(again.status()).toBe(400);
  expect(await again.json()).toEqual({ error: "invalid_grant" });

  const other = await token(request, {
    grant_type: "authorization_code",
    code: await login(request, "bob@test"),
    redirect_uri: `${redirectUri}2`,
    client_id: clientId,
    client_secret: clientSecret,
  });
  expect(other.status()).toBe(400);
  expect(await other.json()).toEqual({ error: "invalid_grant" });
  expect((await exchange(request, "unknown")).status()).toBe(400);
});

test("client authentication: a wrong secret gives 401 invalid_client, Basic works", async ({ request }) => {
  const code = await login(request, "bob@test");
  const wrong = await token(request, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, client_secret: "nope" });
  expect(wrong.status()).toBe(401);
  expect(await wrong.json()).toEqual({ error: "invalid_client" });
  expect((await token(request, { grant_type: "authorization_code", code, redirect_uri: redirectUri })).status()).toBe(401);

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const ok = await token(request, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, { Authorization: `Basic ${basic}` });
  expect(ok.status()).toBe(200);
  const bad = Buffer.from(`${clientId}:nope`).toString("base64");
  expect((await token(request, { grant_type: "refresh_token", refresh_token: "x" }, { Authorization: `Basic ${bad}` })).status()).toBe(401);
});

test("offline access gives a refresh token that renews the access and ID tokens", async ({ request }) => {
  const first = (await (await exchange(request, await login(request, "bob@test", { access_type: "offline" }))).json()) as Record<string, string>;
  expect(first.refresh_token).toBeTruthy();

  const response = await token(request, { grant_type: "refresh_token", refresh_token: first.refresh_token ?? "", client_id: clientId, client_secret: clientSecret });
  expect(response.status()).toBe(200);
  const renewed = (await response.json()) as Record<string, string>;
  expect(renewed.access_token).toBeTruthy();
  expect(renewed.access_token).not.toBe(first.access_token);
  expect(decode((renewed.id_token ?? "").split(".")[1] ?? "")).toMatchObject({ email: "bob@test", aud: clientId });

  const unknown = await token(request, { grant_type: "refresh_token", refresh_token: "unknown", client_id: clientId, client_secret: clientSecret });
  expect(unknown.status()).toBe(400);
  expect(await unknown.json()).toEqual({ error: "invalid_grant" });
  const other = await token(request, { grant_type: "password", client_id: clientId, client_secret: clientSecret });
  expect(other.status()).toBe(400);
  expect(await other.json()).toEqual({ error: "invalid_grant" });
});

test("userinfo answers for its access token only", async ({ request }) => {
  const body = (await (await exchange(request, await login(request, "Bob@Test"))).json()) as { access_token: string };
  const ok = await request.get(`${issuer}/userinfo`, { headers: { Authorization: `Bearer ${body.access_token}` } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({
    sub: `g-${createHash("sha256").update("bob@test").digest("hex").slice(0, 16)}`,
    email: "bob@test",
    email_verified: true,
  });
  expect((await request.get(`${issuer}/userinfo`, { headers: { Authorization: "Bearer nope" } })).status()).toBe(401);
  expect((await request.get(`${issuer}/userinfo`)).status()).toBe(401);
});

test("revoke answers 200", async ({ request }) => {
  expect((await request.post(`${issuer}/revoke`, { form: { token: "anything" } })).status()).toBe(200);
});
