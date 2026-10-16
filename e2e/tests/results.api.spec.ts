import { expect, test, type APIResponse } from "@playwright/test";
import { workerUrl } from "./stack";
import { bearer, claim, enqueue, enroll, getJob, okTranscript, opsHeaders, reset, sendResult, sleep } from "./nodes";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `e2eRes${String(i).padStart(5, "0")}`);

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("E2E-14: an expired lease goes to another node and the late result gets 409", async ({ request }) => {
  const [id] = ids(1) as [string];
  const first = await enroll(request, "node-a");
  const second = await enroll(request, "node-b");
  await enqueue(request, [id]);
  const [leased] = await claim(request, first);
  expect(leased?.video_id).toBe(id);

  await sleep(2500); // LEASE_SECONDS is 2 in the e2e stack
  const [reassigned] = await claim(request, second);
  expect(reassigned?.video_id).toBe(id);
  expect(reassigned?.lease_id).not.toBe(leased?.lease_id);
  expect(await getJob(request, id)).toMatchObject({ status: "leased", leased_by: "node-b", attempts: 2, tried_nodes: ["node-a", "node-b"] });

  const late = await sendResult(request, first, leased?.lease_id ?? "", "ok", okTranscript(id));
  expect(late.status()).toBe(409);
  expect(await late.json()).toMatchObject({ error: { code: "stale_lease" } });
  expect((await request.get(`${workerUrl}/ops/transcripts/${id}`, { headers: opsHeaders })).status()).toBe(404);

  const fresh = await sendResult(request, second, reassigned?.lease_id ?? "", "ok", okTranscript(id));
  expect(await fresh.json()).toEqual({ video_id: id, status: "done" });
  const stored = await (await request.get(`${workerUrl}/ops/transcripts/${id}`, { headers: opsHeaders })).json();
  expect(stored).toMatchObject({ video_id: id, node_id: "node-b", lease_id: reassigned?.lease_id });
});

test("E2E-16: unavailable on 3 nodes gives failed_video and a 4th node gets nothing", async ({ request }) => {
  const [id] = ids(1) as [string];
  const tokens = await Promise.all(["node-a", "node-b", "node-c", "node-d"].map((name) => enroll(request, name)));
  await enqueue(request, [id]);
  for (const [i, token] of tokens.slice(0, 3).entries()) {
    const [leased] = await claim(request, token);
    expect(leased?.video_id).toBe(id);
    const response = await sendResult(request, token, leased?.lease_id ?? "", "unavailable");
    expect(await response.json()).toEqual({ video_id: id, status: i === 2 ? "failed_video" : "queued" });
  }
  expect(await getJob(request, id)).toMatchObject({ status: "failed_video", attempts: 3, last_outcome: "unavailable" });
  expect(await claim(request, tokens[3] ?? "")).toEqual([]);
});

test("E2E-20: a revoked node is refused and its job is reassigned", async ({ request }) => {
  const [id] = ids(1) as [string];
  const revoked = await enroll(request, "node-a");
  const other = await enroll(request, "node-b");
  await enqueue(request, [id]);
  const [leased] = await claim(request, revoked);

  const response = await request.delete(`${workerUrl}/ops/nodes/node-a`, { headers: opsHeaders });
  expect(await response.json()).toEqual({ node_id: "node-a", state: "disabled" });

  expect((await request.post(`${workerUrl}/node/claim`, { headers: bearer(revoked), data: {} })).status()).toBe(401);
  expect((await sendResult(request, revoked, leased?.lease_id ?? "", "ok", okTranscript(id))).status()).toBe(401);
  expect(await getJob(request, id)).toMatchObject({ status: "queued", leased_by: null, last_outcome: "lease_revoked" });

  const [reassigned] = await claim(request, other);
  expect(reassigned?.video_id).toBe(id);
  expect((await sendResult(request, other, reassigned?.lease_id ?? "", "ok", okTranscript(id))).status()).toBe(200);
  expect(await getJob(request, id)).toMatchObject({ status: "done" });
});

test("E2E-21: /node/* responses hold no user data", async ({ request }) => {
  const [id] = ids(1) as [string];
  const label = "Private Owner Label";
  const text = "confidential sentence about someone";
  const token = await enroll(request, "node-a", label);
  await enqueue(request, [id]);

  const bodies: { url: string; text: string }[] = [];
  const keep = async (response: APIResponse): Promise<string> => {
    const text = await response.text();
    bodies.push({ url: response.url(), text });
    return text;
  };

  await keep(await request.post(`${workerUrl}/node/heartbeat`, { headers: bearer(token), data: { version: "1.0.0", uptime_s: 1, jobs_in_progress: 0 } }));
  const claimed = await keep(await request.post(`${workerUrl}/node/claim`, { headers: bearer(token), data: {} }));
  const [leased] = (JSON.parse(claimed) as { jobs: { lease_id: string }[] }).jobs;
  await keep(await sendResult(request, token, leased?.lease_id ?? "", "ok", okTranscript(id, text)));
  await keep(await sendResult(request, token, leased?.lease_id ?? "", "ok", okTranscript(id, text)));
  await keep(await sendResult(request, token, "no-such-lease", "error"));
  await keep(await request.post(`${workerUrl}/node/release`, { headers: bearer(token), data: { lease_id: "no-such-lease" } }));
  await keep(await request.post(`${workerUrl}/node/claim`, { headers: bearer("ytd_node_unknown"), data: {} }));

  const allowed = new Set(["node_id", "state", "hourly_budget", "directive", "jobs", "video_id", "lease_id", "lease_expires_at", "status", "error", "code", "message"]);
  const keys = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap(keys)
      : typeof value === "object" && value !== null
        ? Object.entries(value).flatMap(([key, inner]) => [key, ...keys(inner)])
        : [];
  expect(bodies).toHaveLength(7);
  for (const { url, text: body } of bodies) {
    expect(body).not.toContain(label);
    expect(body).not.toContain(text);
    expect(body).not.toMatch(/@/);
    for (const key of keys(JSON.parse(body))) expect(allowed, `${url} ${key}`).toContain(key);
  }
});
