import { createHash } from "node:crypto";
import { expect, type APIRequestContext } from "@playwright/test";
import { opsHeaders } from "./nodes";
import { workerUrl } from "./stack";

export const redirectUri = "http://127.0.0.1:9/callback";

export async function registerClient(request: APIRequestContext, redirectUris: string[] = [redirectUri], name = "E2E client"): Promise<string> {
  const response = await request.post(`${workerUrl}/register`, { data: { redirect_uris: redirectUris, client_name: name } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

export const authorizeUrl = (clientId: string, over: Record<string, string> = {}, drop: string[] = []): string => {
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    resource: `${workerUrl}/mcp`,
    state: "e2e-state",
    ...over,
  };
  for (const name of drop) delete params[name];
  return `${workerUrl}/authorize?${new URLSearchParams(params).toString()}`;
};

export const invite = async (request: APIRequestContext, email: string): Promise<void> => {
  expect((await request.post(`${workerUrl}/ops/invites`, { headers: opsHeaders, data: { email } })).status()).toBe(200);
};

export async function users(request: APIRequestContext): Promise<{ email: string; role: string }[]> {
  const response = await request.get(`${workerUrl}/ops/users`, { headers: opsHeaders });
  return ((await response.json()) as { users: { email: string; role: string }[] }).users;
}

export const verifier = "e2e-verifier-0123456789-0123456789-0123456789";
export const challenge = createHash("sha256").update(verifier).digest("base64url");

/** Exchanges an authorization code for the access token of the `/mcp` resource. */
export async function exchangeCode(request: APIRequestContext, clientId: string, code: string): Promise<string> {
  const response = await request.post(`${workerUrl}/token`, {
    form: { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: `${workerUrl}/mcp` },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** Logs `email` in over HTTP (consent form, fake Google, callback) and returns an access token. */
export async function accessTokenFor(request: APIRequestContext, email: string): Promise<string> {
  const clientId = await registerClient(request);
  const page = await request.get(authorizeUrl(clientId, { code_challenge: challenge }));
  const requestId = /name="request" value="([^"]+)"/.exec(await page.text())?.[1] ?? "";
  const consent = await request.post(`${workerUrl}/authorize/consent`, { form: { request: requestId, decision: "approve" }, maxRedirects: 0 });
  const google = new URL(consent.headers().location ?? "");
  google.searchParams.set("login_hint", email);
  const signedIn = await request.get(google.toString(), { maxRedirects: 0 });
  const back = await request.get(signedIn.headers().location ?? "", { maxRedirects: 0 });
  const code = new URL(back.headers().location ?? "").searchParams.get("code") ?? "";
  return exchangeCode(request, clientId, code);
}

/** One JSON-RPC message posted to `/mcp`. */
export const mcpPost = (request: APIRequestContext, token: string | null, body: unknown, headers: Record<string, string> = {}) =>
  request.post(`${workerUrl}/mcp`, {
    headers: { Accept: "application/json, text/event-stream", ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers },
    data: body,
  });
