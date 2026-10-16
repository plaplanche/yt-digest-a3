import { expect, test } from "@playwright/test";
import { reset } from "./nodes";
import { authorizeUrl, redirectUri, registerClient } from "./oauth";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

// E2E-29
test("authorize refuses a missing PKCE challenge, plain PKCE and a non-exact redirect_uri", async ({ request }) => {
  const clientId = await registerClient(request);
  const refused = async (url: string): Promise<URL> => {
    const response = await request.get(url, { maxRedirects: 0 });
    expect(response.status(), url).toBe(302);
    return new URL(response.headers().location ?? "");
  };

  const noChallenge = await refused(authorizeUrl(clientId, {}, ["code_challenge", "code_challenge_method"]));
  expect(`${noChallenge.origin}${noChallenge.pathname}`).toBe(redirectUri);
  expect(noChallenge.searchParams.get("error")).toBe("invalid_request");
  expect(noChallenge.searchParams.get("state")).toBe("e2e-state");

  const noMethod = await refused(authorizeUrl(clientId, {}, ["code_challenge_method"]));
  expect(noMethod.searchParams.get("error")).toBe("invalid_request");

  const plain = await refused(authorizeUrl(clientId, { code_challenge_method: "plain" }));
  expect(plain.searchParams.get("error")).toBe("invalid_request");

  for (const uri of [`${redirectUri}/`, `${redirectUri}?x=1`, "http://127.0.0.1:9/callback2", "https://evil.example/callback"]) {
    const response = await request.get(authorizeUrl(clientId, { redirect_uri: uri }), { maxRedirects: 0 });
    expect(response.status(), uri).toBe(400);
    expect(response.headers().location).toBeUndefined();
    expect(response.headers()["content-type"]).toContain("text/html");
  }
  const missing = await request.get(authorizeUrl(clientId, {}, ["redirect_uri"]), { maxRedirects: 0 });
  expect(missing.status()).toBe(400);
});

test("a valid authorization request shows the consent page", async ({ request }) => {
  const clientId = await registerClient(request);
  const response = await request.get(authorizeUrl(clientId));
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("E2E client");
  expect(html).toContain('name="decision" value="approve"');
  expect(html).toContain('name="decision" value="deny"');
});
