import { createHash, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { reset } from "./nodes";
import { authorizeUrl, invite, redirectUri, registerClient } from "./oauth";
import { workerUrl } from "./stack";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

const location = (response: { headers: () => Record<string, string> }): URL => new URL(response.headers().location ?? "");

/** The login over HTTP: consent form, then the fake Google with a login_hint, then the callback; returns the code. */
async function login(request: APIRequestContext, clientId: string, challenge: string, email: string): Promise<string> {
  const page = await request.get(authorizeUrl(clientId, { code_challenge: challenge }));
  expect(page.status()).toBe(200);
  const requestId = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const consent = await request.post(`${workerUrl}/authorize/consent`, { form: { request: requestId, decision: "approve" }, maxRedirects: 0 });
  expect(consent.status()).toBe(302);
  const google = location(consent);
  google.searchParams.set("login_hint", email);
  const signedIn = await request.get(google.toString(), { maxRedirects: 0 });
  expect(signedIn.status()).toBe(302);
  const back = await request.get(location(signedIn).toString(), { maxRedirects: 0 });
  expect(back.status()).toBe(302);
  const target = location(back);
  expect(`${target.origin}${target.pathname}`).toBe(redirectUri);
  expect(target.searchParams.get("state")).toBe("e2e-state");
  return target.searchParams.get("code") ?? "";
}

const tokenRequest = (request: APIRequestContext, form: Record<string, string>) => request.post(`${workerUrl}/token`, { form });

// E2E-31
test("a refresh rotates the tokens and the reuse of an old refresh token revokes the family", async ({ request }) => {
  const clientId = await registerClient(request);
  await invite(request, "bob@test");
  const verifier = randomBytes(32).toString("base64url");
  const code = await login(request, clientId, createHash("sha256").update(verifier).digest("base64url"), "bob@test");

  const exchange = { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: `${workerUrl}/mcp` };
  const first = await tokenRequest(request, exchange);
  expect(first.status()).toBe(200);
  expect(first.headers()["cache-control"]).toBe("no-store");
  const one = (await first.json()) as Tokens;
  expect(one).toMatchObject({ token_type: "Bearer", scope: "digest", expires_in: 3600 });

  const used = await tokenRequest(request, exchange);
  expect(used.status()).toBe(400);
  expect(await used.json()).toMatchObject({ error: "invalid_grant" });

  const rotated = await tokenRequest(request, { grant_type: "refresh_token", refresh_token: one.refresh_token, client_id: clientId });
  expect(rotated.status()).toBe(200);
  const two = (await rotated.json()) as Tokens;
  expect(two.refresh_token).not.toBe(one.refresh_token);
  expect(two.access_token).not.toBe(one.access_token);

  const again = await tokenRequest(request, { grant_type: "refresh_token", refresh_token: two.refresh_token, client_id: clientId, resource: `${workerUrl}/mcp` });
  expect(again.status()).toBe(200);
  const three = (await again.json()) as Tokens;

  // The old refresh token is replayed: invalid_grant, and the family is revoked with it.
  const reuse = await tokenRequest(request, { grant_type: "refresh_token", refresh_token: one.refresh_token, client_id: clientId });
  expect(reuse.status()).toBe(400);
  expect(await reuse.json()).toMatchObject({ error: "invalid_grant" });
  for (const token of [two.refresh_token, three.refresh_token]) {
    const refused = await tokenRequest(request, { grant_type: "refresh_token", refresh_token: token, client_id: clientId });
    expect(refused.status()).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_grant" });
  }
});
