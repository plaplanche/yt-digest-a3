import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";
import { call, ops } from "./helpers";

const post = (path: string, body: unknown, token?: string, settings?: Parameters<typeof call>[2]): Promise<Response> =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } }, settings);

const vid = (n: number): string => `video${String(n).padStart(6, "0")}`;

async function enroll(nodeId: string): Promise<string> {
  const response = await ops("/ops/nodes", { method: "POST", body: JSON.stringify({ node_id: nodeId, owner_label: "Owner" }) });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

const enqueue = (ids: string[], priority?: number): Promise<Response> =>
  ops("/ops/jobs", { method: "POST", body: JSON.stringify({ video_ids: ids, priority }) });

interface Job {
  video_id: string;
  lease_id: string;
  lease_expires_at: string;
}
const claim = async (token: string, body: unknown = {}): Promise<Job[]> => {
  const response = await post("/node/claim", body, token);
  expect(response.status).toBe(200);
  return ((await response.json()) as { jobs: Job[] }).jobs;
};
const job = async (id: string): Promise<Record<string, unknown>> => (await (await ops(`/ops/jobs/${id}`)).json()) as Record<string, unknown>;

beforeEach(async () => {
  await ops("/ops/reset", { method: "POST" });
});

describe("POST /ops/nodes", () => {
  test("shows the token once, stores only its SHA-256, and refuses a second enrolment", async () => {
    const response = await ops("/ops/nodes", { method: "POST", body: JSON.stringify({ node_id: "n-1", owner_label: "Alice" }) });
    const body = (await response.json()) as { node_id: string; owner_label: string; token: string };
    expect(body).toMatchObject({ node_id: "n-1", owner_label: "Alice" });
    expect(body.token).toMatch(/^ytd_node_[A-Za-z0-9_-]{43}$/);
    const row = await env.DB.prepare("SELECT token_hash, state FROM nodes WHERE node_id = 'n-1'").first<{ token_hash: string; state: string }>();
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.token)));
    expect(row).toEqual({ token_hash: Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""), state: "healthy" });

    const again = await ops("/ops/nodes", { method: "POST", body: JSON.stringify({ node_id: "n-1", owner_label: "Bob" }) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "conflict" } });
  });

  test.each([{ node_id: "Bad", owner_label: "x" }, { node_id: "-a", owner_label: "x" }, { node_id: "a".repeat(64), owner_label: "x" }, { node_id: "a", owner_label: "" }, { node_id: "a", owner_label: "x".repeat(101) }, { node_id: "a" }, { node_id: "a", owner_label: "x", extra: 1 }])(
    "rejects %j",
    async (body) => {
      const response = await ops("/ops/nodes", { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    },
  );
});

describe("POST /ops/jobs and GET /ops/jobs/<video_id>", () => {
  test("enqueues new ids in request order and keeps existing ones", async () => {
    await enqueue([vid(1)], 5);
    const response = await enqueue([vid(2), vid(1), vid(2)], 1);
    expect(await response.json()).toEqual({ enqueued: [vid(2)], existing: [vid(1), vid(2)] });
    expect(await job(vid(2))).toMatchObject({ video_id: vid(2), kind: "primary", priority: 1, status: "queued", leased_by: null, lease_expires_at: null, attempts: 0, tried_nodes: [], last_outcome: null, done_at: null });
  });

  test("an existing job's priority only goes up", async () => {
    await enqueue([vid(1)], 5);
    await enqueue([vid(1)], 2);
    expect(await job(vid(1))).toMatchObject({ priority: 5 });
    await enqueue([vid(1)], 9);
    expect(await job(vid(1))).toMatchObject({ priority: 9, status: "queued", attempts: 0 });
  });

  test("an existing leased job is left as it is", async () => {
    const token = await enroll("n1");
    await enqueue([vid(1)]);
    await claim(token);
    await enqueue([vid(1)], 4);
    expect(await job(vid(1))).toMatchObject({ priority: 4, status: "leased", attempts: 1, tried_nodes: ["n1"] });
  });

  test.each([{ video_ids: [] }, { video_ids: ["short"] }, { video_ids: Array.from({ length: 101 }, (_, i) => vid(i)) }, { video_ids: [vid(1)], priority: -1 }, { video_ids: [vid(1)], priority: 1.5 }, { priority: 1 }, { video_ids: [vid(1)], x: 1 }])(
    "rejects %j",
    async (body) => {
      const response = await ops("/ops/jobs", { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    },
  );

  test("accepts 100 ids and gives 404 for an unknown job", async () => {
    const response = await enqueue(Array.from({ length: 100 }, (_, i) => vid(i)));
    expect(((await response.json()) as { enqueued: string[] }).enqueued).toHaveLength(100);
    expect((await ops(`/ops/jobs/${vid(999)}`)).status).toBe(404);
  });
});

describe("node authentication", () => {
  const routes = ["/node/heartbeat", "/node/claim"];

  test.each(routes)("%s: no bearer, unknown token and operator token give 401", async (path) => {
    await enroll("n1");
    for (const token of [undefined, "ytd_node_unknown", "ops-test"]) {
      const response = await post(path, {}, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }
  });

  test("a revoked node's token gives 401", async () => {
    const token = await enroll("n1");
    await env.DB.prepare("UPDATE nodes SET revoked_at = '2026-10-16T07:00:00.000Z', state = 'disabled'").run();
    expect((await post("/node/claim", {}, token)).status).toBe(401);
  });

  test("authentication comes before body validation, and an unknown route or method is 404", async () => {
    expect((await call("/node/claim", { method: "POST", body: "{not json" })).status).toBe(401);
    const token = await enroll("n1");
    expect((await post("/node/nothing", {}, token)).status).toBe(404);
    expect((await call("/node/claim", { method: "GET", headers: { Authorization: `Bearer ${token}` } })).status).toBe(404);
  });
});

describe("POST /node/heartbeat", () => {
  const body = { version: "0.1.0", uptime_s: 3, jobs_in_progress: 0 };

  test("updates the node and answers healthy, run, 60", async () => {
    const token = await enroll("n1");
    const before = Date.now();
    const response = await post("/node/heartbeat", body, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ node_id: "n1", state: "healthy", hourly_budget: 60, directive: "run" });
    const row = await env.DB.prepare("SELECT last_heartbeat_at, version FROM nodes").first<{ last_heartbeat_at: string; version: string }>();
    expect(row?.version).toBe("0.1.0");
    expect(Date.parse(row?.last_heartbeat_at ?? "")).toBeGreaterThanOrEqual(before);
  });

  test("accepts the optional fields", async () => {
    const token = await enroll("n1");
    const full = { ...body, last_success_at: "2026-10-16T07:00:01.123Z", last_blocked_at: null, disk_free_ratio: 0.5, cpu_temp_c: 40 };
    expect((await post("/node/heartbeat", full, token)).status).toBe(200);
  });

  test.each([{}, { ...body, version: "" }, { ...body, version: "v".repeat(65) }, { ...body, uptime_s: -1 }, { ...body, jobs_in_progress: 1.5 }, { ...body, last_success_at: "yesterday" }, { ...body, disk_free_ratio: 1.1 }, { ...body, cpu_temp_c: "hot" }, { ...body, extra: 1 }])(
    "rejects %j without updating the node",
    async (bad) => {
      const token = await enroll("n1");
      const response = await post("/node/heartbeat", bad, token);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
      expect((await env.DB.prepare("SELECT last_heartbeat_at FROM nodes").first<{ last_heartbeat_at: string | null }>())?.last_heartbeat_at).toBeNull();
    },
  );

  test("rejects a body that is not JSON", async () => {
    const token = await enroll("n1");
    const response = await call("/node/heartbeat", { method: "POST", body: "{not json", headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
  });
});

describe("POST /node/claim", () => {
  test("an empty queue gives no job", async () => {
    const token = await enroll("n1");
    const response = await post("/node/claim", {}, token);
    expect(await response.json()).toEqual({ jobs: [] });
  });

  test("takes 3 jobs without max_jobs, by priority then creation order", async () => {
    const token = await enroll("n1");
    await enqueue([vid(1)], 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueue([vid(2)], 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueue([vid(3), vid(4)], 7);
    await enqueue([vid(5)], 0);
    const jobs = await claim(token);
    expect(jobs.map((j) => j.video_id)).toEqual([vid(3), vid(4), vid(1)]);
    expect(await claim(token, { max_jobs: 10 })).toHaveLength(2);
  });

  test("ties on priority and creation time are broken by video id", async () => {
    const token = await enroll("n1");
    await enqueue([vid(9), vid(3), vid(5)]);
    expect((await claim(token)).map((j) => j.video_id)).toEqual([vid(3), vid(5), vid(9)]);
  });

  test("a claimed job is leased with attempts 1, the node in tried_nodes and an active lease row", async () => {
    const token = await enroll("n1");
    await enqueue([vid(1)]);
    const before = Date.now();
    const [claimed] = await claim(token, { max_jobs: 1 });
    expect(claimed?.lease_id.length).toBeGreaterThanOrEqual(16);
    expect(Date.parse(claimed?.lease_expires_at ?? "") - before).toBeGreaterThanOrEqual(599_000);
    expect(claimed?.lease_expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await job(vid(1))).toMatchObject({ status: "leased", leased_by: "n1", attempts: 1, tried_nodes: ["n1"], lease_expires_at: claimed?.lease_expires_at });
    const lease = await env.DB.prepare("SELECT * FROM leases").first<Record<string, unknown>>();
    expect(lease).toMatchObject({ lease_id: claimed?.lease_id, video_id: vid(1), node_id: "n1", expires_at: claimed?.lease_expires_at, state: "active" });
    const stored = await env.DB.prepare("SELECT lease_id FROM jobs").first<{ lease_id: string }>();
    expect(stored?.lease_id).toBe(claimed?.lease_id);
  });

  test("LEASE_SECONDS sets the lease duration", async () => {
    const token = await enroll("n1");
    await enqueue([vid(1)]);
    const response = await post("/node/claim", {}, token, { OPS_TOKEN: "ops-test", LEASE_SECONDS: "2" });
    const [claimed] = ((await response.json()) as { jobs: Job[] }).jobs;
    const seconds = (Date.parse(claimed?.lease_expires_at ?? "") - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThanOrEqual(2);
  });

  test("a leased job is not handed out again, and a node in tried_nodes does not get it", async () => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue([vid(1)]);
    expect(await claim(t1)).toHaveLength(1);
    expect(await claim(t2)).toEqual([]);
    await env.DB.prepare("UPDATE jobs SET status = 'queued', leased_by = NULL, lease_id = NULL, lease_expires_at = NULL").run();
    expect(await claim(t1)).toEqual([]);
    expect(await claim(t2)).toHaveLength(1);
    expect(await job(vid(1))).toMatchObject({ attempts: 2, tried_nodes: ["n1", "n2"] });
  });

  test("done and failed_video jobs are never handed out", async () => {
    const token = await enroll("n1");
    await enqueue([vid(1), vid(2)]);
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE video_id = ?1").bind(vid(1)).run();
    await env.DB.prepare("UPDATE jobs SET status = 'failed_video' WHERE video_id = ?1").bind(vid(2)).run();
    expect(await claim(token)).toEqual([]);
  });

  test.each([{ max_jobs: 0 }, { max_jobs: 11 }, { max_jobs: 1.5 }, { max_jobs: "3" }, { extra: 1 }])("rejects %j", async (bad) => {
    const token = await enroll("n1");
    await enqueue([vid(1)]);
    const response = await post("/node/claim", bad, token);
    expect(response.status).toBe(400);
    expect((await job(vid(1))).status).toBe("queued");
  });

  test("concurrent claims of several nodes hand out no job twice and none comes back short", async () => {
    const tokens = await Promise.all(["n1", "n2", "n3", "n4"].map(enroll));
    const total = 20;
    await enqueue(Array.from({ length: total }, (_, i) => vid(i)));

    const results = await Promise.all(tokens.map((token) => claim(token, { max_jobs: 4 })));

    expect(results.map((jobs) => jobs.length)).toEqual([4, 4, 4, 4]);
    const ids = results.flat().map((j) => j.video_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(results.flat().map((j) => j.lease_id)).size).toBe(ids.length);
    const leases = await env.DB.prepare("SELECT COUNT(*) AS n FROM leases WHERE state = 'active'").first<{ n: number }>();
    expect(leases?.n).toBe(ids.length);
  });

  test("concurrent claims over fewer jobs than asked share them exactly", async () => {
    const tokens = await Promise.all(["n1", "n2", "n3"].map(enroll));
    await enqueue(Array.from({ length: 7 }, (_, i) => vid(i)));

    const results = await Promise.all(tokens.map((token) => claim(token, { max_jobs: 3 })));

    const sizes = results.map((jobs) => jobs.length).sort();
    expect(sizes).toEqual([1, 3, 3]);
    expect(new Set(results.flat().map((j) => j.video_id)).size).toBe(7);
  });
});
