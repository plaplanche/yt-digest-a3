import { expect, test, type Page } from "@playwright/test";
import { reset } from "./nodes";
import { authorizeUrl, challenge, exchangeCode, invite, mcpPost, redirectUri, registerClient, users } from "./oauth";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

/** Walks the consent page and the fake Google sign-in page as the given user. */
async function signIn(page: Page, clientId: string, email: string): Promise<void> {
  await page.goto(authorizeUrl(clientId));
  await expect(page.getByText("E2E client")).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator('input[name="login_hint"]').fill(email);
  await page.locator('button[type="submit"], input[type="submit"]').click();
}

test("the consent page then the fake Google sign-in lead an invited user back to the client with a code", async ({ page, request }) => {
  const clientId = await registerClient(request);
  await invite(request, "bob@test");
  await page.route(`${redirectUri}**`, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "client" }));
  const back = page.waitForRequest((r) => r.url().startsWith(redirectUri));
  await signIn(page, clientId, "bob@test");
  const url = new URL((await back).url());
  expect(url.searchParams.get("code")?.length).toBeGreaterThanOrEqual(32);
  expect(url.searchParams.get("state")).toBe("e2e-state");
  expect(await users(request)).toEqual([expect.objectContaining({ email: "bob@test", role: "member" })]);
});

// E2E-02
test("a non-invited user gets the 403 page and no users row", async ({ page, request }) => {
  const clientId = await registerClient(request);
  await invite(request, "bob@test");
  await signIn(page, clientId, "mallory@test");
  await expect(page).toHaveTitle("Access refused");
  await expect(page.getByText("This account is not invited.")).toBeVisible();
  expect(await users(request)).toEqual([]);
});

// E2E-28
test("the token obtained through the browser login lists and calls list_subscriptions", async ({ page, request }) => {
  const clientId = await registerClient(request);
  await invite(request, "bob@test");
  await page.route(`${redirectUri}**`, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "client" }));
  const back = page.waitForRequest((r) => r.url().startsWith(redirectUri));
  await page.goto(authorizeUrl(clientId, { code_challenge: challenge }));
  await page.getByRole("button", { name: "Approve" }).click();
  await page.locator('input[name="login_hint"]').fill("bob@test");
  await page.locator('button[type="submit"], input[type="submit"]').click();
  const code = new URL((await back).url()).searchParams.get("code") ?? "";
  const token = await exchangeCode(request, clientId, code);

  const init = await mcpPost(request, token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } } });
  expect(await init.json()).toMatchObject({ result: { protocolVersion: "2025-06-18" } });
  expect((await mcpPost(request, token, { jsonrpc: "2.0", method: "notifications/initialized" })).status()).toBe(202);
  const list = (await (await mcpPost(request, token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as { result: { tools: { name: string }[] } };
  expect(list.result.tools.map((t) => t.name)).toEqual(["list_subscriptions"]);
  const call = await mcpPost(request, token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_subscriptions", arguments: {} } });
  expect(await call.json()).toMatchObject({ result: { isError: false, content: [{ type: "text", text: '{"subscriptions":[]}' }] } });
});
