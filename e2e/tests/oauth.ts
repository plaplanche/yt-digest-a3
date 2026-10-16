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
