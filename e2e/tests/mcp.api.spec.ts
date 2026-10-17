import { expect, test } from "@playwright/test";
import { bearer, enroll, enqueue, opsHeaders, reset } from "./nodes";
import { accessTokenFor, invite, mcpPost } from "./oauth";
import { workerUrl } from "./stack";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } };
const metadataUrl = `${workerUrl}/.well-known/oauth-protected-resource`;

// E2E-27
test("/mcp without a token gets 401 and WWW-Authenticate, and the discovery documents are served and consistent", async ({ request }) => {
  const response = await mcpPost(request, null, initialize);
  expect(response.status()).toBe(401);
  expect(response.headers()["www-authenticate"]).toContain(`resource_metadata="${metadataUrl}"`);
  expect(await response.json()).toMatchObject({ error: "invalid_token" });

  const resource = await request.get(metadataUrl);
  expect(resource.status()).toBe(200);
  const resourceDoc = (await resource.json()) as { resource: string; authorization_servers: string[] };
  expect(resourceDoc.resource).toBe(`${workerUrl}/mcp`);
  expect(await (await request.get(`${metadataUrl}/mcp`)).json()).toEqual(resourceDoc);

  const server = await request.get(`${resourceDoc.authorization_servers[0]}/.well-known/oauth-authorization-server`);
  expect(server.status()).toBe(200);
  expect(await server.json()).toMatchObject({
    issuer: workerUrl,
    authorization_endpoint: `${workerUrl}/authorize`,
    token_endpoint: `${workerUrl}/token`,
    registration_endpoint: `${workerUrl}/register`,
  });
});

// E2E-33
test("a revoked invite refuses the user's valid access token", async ({ request }) => {
  await invite(request, "bob@test");
  const token = await accessTokenFor(request, "bob@test");
  expect((await mcpPost(request, token, initialize)).status()).toBe(200);

  const revoked = await request.post(`${workerUrl}/ops/invites/revoke`, { headers: opsHeaders, data: { email: "bob@test" } });
  expect(revoked.status()).toBe(200);
  const refused = await mcpPost(request, token, initialize);
  expect(refused.status()).toBe(401);
  expect(refused.headers()["www-authenticate"]).toContain("resource_metadata=");
});

// E2E-37
test("a node token on /mcp and an access token on /node/* are refused", async ({ request }) => {
  const nodeToken = await enroll(request, "node-1");
  await enqueue(request, ["aaaaaaaaaaa"]);
  await invite(request, "bob@test");
  const access = await accessTokenFor(request, "bob@test");

  const onMcp = await mcpPost(request, nodeToken, initialize);
  expect(onMcp.status()).toBe(401);
  expect(onMcp.headers()["www-authenticate"]).toContain("resource_metadata=");

  const onNode = await request.post(`${workerUrl}/node/claim`, { headers: bearer(access), data: { max_jobs: 1 } });
  expect(onNode.status()).toBe(401);
  // The job stays unclaimed: the node token still gets it.
  const claim = await request.post(`${workerUrl}/node/claim`, { headers: bearer(nodeToken), data: { max_jobs: 1 } });
  expect(((await claim.json()) as { jobs: unknown[] }).jobs).toHaveLength(1);
});
