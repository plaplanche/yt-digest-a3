import { expect, test } from "@playwright/test";
import { mocksUrl, workerUrl } from "./stack";

test("the Worker answers /health", async ({ request }) => {
  const response = await request.get(`${workerUrl}/health`);
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe("ok");
  expect(typeof body.version).toBe("string");
});

test("the mocks server answers /health", async ({ request }) => {
  const response = await request.get(`${mocksUrl}/health`);
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok" });
});

test("SponsorBlock has no segment for any video", async ({ request }) => {
  const response = await request.get(
    `${mocksUrl}/sponsorblock/api/skipSegments?videoID=dQw4w9WgXcQ`,
  );
  expect(response.status()).toBe(404);
  expect(await response.text()).toBe("Not Found");
});
