import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { call, ops } from "./helpers";

const SETTINGS = { OPS_TOKEN: "ops-test", LEASE_SECONDS: "2" };

const post = (path: string, body: unknown, token?: string, settings: Parameters<typeof call>[2] = SETTINGS): Promise<Response> =>
  call(path, { method: "POST", body: JSON.stringify(body), headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } }, settings);

const vid = (n: number): string => `video${String(n).padStart(6, "0")}`;

async function enroll(nodeId: string): Promise<string> {
  const response = await ops("/ops/nodes", { method: "POST", body: JSON.stringify({ node_id: nodeId, owner_label: "Owner" }) });
  return ((await response.json()) as { token: string }).token;
}

const enqueue = (...ids: string[]): Promise<Response> => ops("/ops/jobs", { method: "POST", body: JSON.stringify({ video_ids: ids }) });

interface Claimed {
  video_id: string;
  lease_id: string;
  lease_expires_at: string;
}
const claim = async (token: string, max = 1): Promise<Claimed[]> => ((await (await post("/node/claim", { max_jobs: max }, token)).json()) as { jobs: Claimed[] }).jobs;
const job = async (id: string): Promise<Record<string, unknown>> => (await (await ops(`/ops/jobs/${id}`)).json()) as Record<string, unknown>;

const transcript = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  video_id: id,
  status: "ok",
  lang: "en",
  source: "manual",
  word_count: 5,
  truncated: false,
  sponsor_ratio: null,
  pages: ["hello brave new\n\nworld again"],
  ...over,
});
const okResult = (lease: Claimed, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  lease_id: lease.lease_id,
  outcome: "ok",
  transcript: transcript(lease.video_id, over),
});
const failure = (lease: Claimed, outcome: string): Record<string, unknown> => ({ lease_id: lease.lease_id, outcome, transcript: null });

const count = async (table: string, where = "1"): Promise<number> => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<{ n: number }>())?.n ?? -1;
const leaseState = async (lease: Claimed): Promise<string | undefined> =>
  (await env.DB.prepare("SELECT state FROM leases WHERE lease_id = ?1").bind(lease.lease_id).first<{ state: string }>())?.state;
const objects = async (): Promise<number> => (await env.TRANSCRIPTS.list({ prefix: "transcripts/" })).objects.length;

let logged: Record<string, unknown>[] = [];
beforeEach(async () => {
  await ops("/ops/reset", { method: "POST" });
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    try {
      logged.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // not a log line
    }
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const events = (name: string): Record<string, unknown>[] => logged.filter((line) => line.event === name);

describe("POST /node/result: ok", () => {
  test("stores the transcript in R2 with its metadata and makes the job done", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const sent = okResult(lease as Claimed);
    const response = await post("/node/result", sent, token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ video_id: vid(1), status: "done" });

    const object = await env.TRANSCRIPTS.get(`transcripts/${vid(1)}.json`);
    expect(JSON.parse((await object?.text()) ?? "")).toEqual(sent.transcript);
    expect(object?.httpMetadata?.contentType).toBe("application/json");
    expect(object?.customMetadata).toMatchObject({ node_id: "n1", lease_id: lease?.lease_id });
    expect(object?.customMetadata?.produced_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await job(vid(1))).toMatchObject({ status: "done", last_outcome: "ok", attempts: 1 });
    expect(((await job(vid(1))).done_at as string) > "2026").toBe(true);
    expect(await leaseState(lease as Claimed)).toBe("completed");
    expect(await count("node_events", "kind = 'job_ok' AND node_id = 'n1'")).toBe(1);
    expect(events("job.completed")).toMatchObject([{ video_id: vid(1), attrs: { node_id: "n1", outcome: "ok", status: "done" } }]);
  });

  test("GET /ops/transcripts/<video_id> returns it, and 404 when there is none", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    await post("/node/result", okResult(lease as Claimed), token);
    const shown = (await (await ops(`/ops/transcripts/${vid(1)}`)).json()) as Record<string, unknown>;
    expect(shown).toMatchObject({ video_id: vid(1), transcript: transcript(vid(1)), node_id: "n1", lease_id: lease?.lease_id });
    expect(shown.produced_at).toMatch(/Z$/);
    expect((await ops(`/ops/transcripts/${vid(2)}`)).status).toBe(404);
    expect((await ops("/ops/transcripts/short")).status).toBe(404);
  });

  test("the same result again gives the same 200 and writes nothing, whatever the new body holds", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const first = await post("/node/result", okResult(lease as Claimed), token);
    const etag = (await env.TRANSCRIPTS.head(`transcripts/${vid(1)}.json`))?.etag;

    const again = await post("/node/result", okResult(lease as Claimed), token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    const other = await post("/node/result", failure(lease as Claimed, "error"), token);
    expect(other.status).toBe(200);
    expect(await other.json()).toEqual({ video_id: vid(1), status: "done" });
    expect((await env.TRANSCRIPTS.head(`transcripts/${vid(1)}.json`))?.etag).toBe(etag);
    expect(await count("node_events")).toBe(1);
    expect(events("job.completed")).toHaveLength(1);
    expect(await job(vid(1))).toMatchObject({ status: "done", last_outcome: "ok" });
  });

  test("an existing object is never overwritten", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    await env.TRANSCRIPTS.put(`transcripts/${vid(1)}.json`, '{"kept":true}');
    const [lease] = await claim(token);
    expect((await post("/node/result", okResult(lease as Claimed), token)).status).toBe(200);
    expect(await (await env.TRANSCRIPTS.get(`transcripts/${vid(1)}.json`))?.text()).toBe('{"kept":true}');
    expect(await job(vid(1))).toMatchObject({ status: "done" });
  });

  test("an R2 failure gives 503, keeps the lease active and the job leased, and a retry succeeds", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const broken = { ...SETTINGS, TRANSCRIPTS: { put: () => Promise.reject(new Error("r2 down")) } as unknown as R2Bucket };
    const response = await post("/node/result", okResult(lease as Claimed), token, broken);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "storage_error" } });
    expect(await leaseState(lease as Claimed)).toBe("active");
    expect(await job(vid(1))).toMatchObject({ status: "leased", last_outcome: null });
    expect(await count("node_events")).toBe(0);

    expect((await post("/node/result", okResult(lease as Claimed), token)).status).toBe(200);
    expect(await job(vid(1))).toMatchObject({ status: "done" });
  });
});

describe("POST /node/result: other outcomes", () => {
  test("no_transcript is terminal and writes nothing to R2", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const response = await post("/node/result", failure(lease as Claimed, "no_transcript"), token);
    expect(await response.json()).toEqual({ video_id: vid(1), status: "done" });
    expect(await objects()).toBe(0);
    expect(await job(vid(1))).toMatchObject({ status: "done", last_outcome: "no_transcript" });
    expect(await count("node_events", "kind = 'job_no_transcript'")).toBe(1);
  });

  test.each(["unavailable", "blocked", "error"])("%s requeues the job for another node", async (outcome) => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1));
    const [lease] = await claim(t1);
    const response = await post("/node/result", failure(lease as Claimed, outcome), t1);
    expect(await response.json()).toEqual({ video_id: vid(1), status: "queued" });
    expect(await job(vid(1))).toMatchObject({ status: "queued", leased_by: null, lease_expires_at: null, attempts: 1, tried_nodes: ["n1"], last_outcome: outcome, done_at: null });
    expect(await count("node_events", `kind = 'job_${outcome}'`)).toBe(1);
    expect(await claim(t1)).toEqual([]);
    expect(await claim(t2)).toHaveLength(1);
  });

  test("the third failure gives failed_video, which is never handed out again", async () => {
    const tokens = await Promise.all(["n1", "n2", "n3", "n4"].map(enroll));
    await enqueue(vid(1));
    for (const [i, outcome] of ["unavailable", "blocked", "error"].entries()) {
      const [lease] = await claim(tokens[i] as string);
      const response = await post("/node/result", failure(lease as Claimed, outcome), tokens[i]);
      expect(await response.json()).toEqual({ video_id: vid(1), status: i === 2 ? "failed_video" : "queued" });
    }
    expect(await job(vid(1))).toMatchObject({ status: "failed_video", attempts: 3, tried_nodes: ["n1", "n2", "n3"], leased_by: null, last_outcome: "error" });
    expect(((await job(vid(1))).done_at as string) > "2026").toBe(true);
    expect(await claim(tokens[3] as string)).toEqual([]);
  });
});

describe("POST /node/result: validation", () => {
  const cases: [string, (lease: Claimed) => Record<string, unknown>][] = [
    ["ok without a transcript", (l) => ({ lease_id: l.lease_id, outcome: "ok", transcript: null })],
    ["ok with a transcript whose status is not ok", (l) => okResult(l, { status: "unavailable", pages: [], word_count: 0 })],
    ["ok with another video id", (l) => okResult(l, { video_id: vid(77) })],
    ["ok without pages", (l) => okResult(l, { pages: [], word_count: 0 })],
    ["ok with a wrong word_count", (l) => okResult(l, { word_count: 6 })],
    ["no_transcript with a transcript", (l) => ({ lease_id: l.lease_id, outcome: "no_transcript", transcript: transcript(l.video_id) })],
    ["error with a transcript", (l) => ({ lease_id: l.lease_id, outcome: "error", transcript: transcript(l.video_id) })],
  ];

  test.each(cases)("%s: 422, the lease is rejected and it counts as a failure", async (_name, build) => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1));
    const [lease] = await claim(t1);
    const response = await post("/node/result", build(lease as Claimed), t1);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(await leaseState(lease as Claimed)).toBe("rejected");
    expect(await job(vid(1))).toMatchObject({ status: "queued", attempts: 1, last_outcome: "validation_failed", leased_by: null });
    expect(await count("node_events", "kind = 'validation_failed' AND node_id = 'n1'")).toBe(1);
    expect(await objects()).toBe(0);
    expect(events("job.validation_failed")).toMatchObject([{ video_id: vid(1), attrs: { node_id: "n1" } }]);
    expect(typeof (events("job.validation_failed")[0]?.attrs as { reason: unknown }).reason).toBe("string");
    expect((await post("/node/result", failure(lease as Claimed, "error"), t1)).status).toBe(409);
    expect(await claim(t2)).toHaveLength(1);
  });

  test("word_count ignores the [...] marker and counts any whitespace", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const pages = ["one two\n\n[…]\n\nthree\tfour", "five  six\nseven"];
    expect((await post("/node/result", okResult(lease as Claimed, { pages, word_count: 7, truncated: true }), token)).status).toBe(200);
  });

  test("a third validation failure gives failed_video", async () => {
    const tokens = await Promise.all(["n1", "n2", "n3"].map(enroll));
    await enqueue(vid(1));
    for (const token of tokens) {
      const [lease] = await claim(token);
      expect((await post("/node/result", okResult(lease as Claimed, { word_count: 99 }), token)).status).toBe(422);
    }
    expect(await job(vid(1))).toMatchObject({ status: "failed_video", attempts: 3, last_outcome: "validation_failed" });
  });

  test.each([
    {},
    { outcome: "ok", transcript: null },
    { lease_id: "", outcome: "error", transcript: null },
    { lease_id: "x", outcome: "done", transcript: null },
    { lease_id: "x", outcome: "error" },
    { lease_id: "x", outcome: "error", transcript: null, extra: 1 },
    { lease_id: "x", outcome: "ok", transcript: "text" },
    { lease_id: "x", outcome: "ok", transcript: { ...transcript(vid(1)), extra: 1 } },
    { lease_id: "x", outcome: "ok", transcript: transcript("short") },
    { lease_id: "x", outcome: "ok", transcript: transcript(vid(1), { status: "weird" }) },
    { lease_id: "x", outcome: "ok", transcript: transcript(vid(1), { word_count: -1 }) },
    { lease_id: "x", outcome: "ok", transcript: transcript(vid(1), { sponsor_ratio: 2 }) },
    { lease_id: "x", outcome: "ok", transcript: transcript(vid(1), { pages: [1] }) },
  ])("a body that breaks the schema gives 400 and changes nothing: %j", async (body) => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const sent = (body as { lease_id?: string }).lease_id === "x" ? { ...body, lease_id: lease?.lease_id } : body;
    const response = await post("/node/result", sent, token);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
    expect(await job(vid(1))).toMatchObject({ status: "leased", last_outcome: null });
    expect(await leaseState(lease as Claimed)).toBe("active");
  });

  test("a body that is not JSON gives 400", async () => {
    const token = await enroll("n1");
    const response = await call("/node/result", { method: "POST", body: "{nope", headers: { Authorization: `Bearer ${token}` } }, SETTINGS);
    expect(response.status).toBe(400);
  });
});

describe("stale leases", () => {
  test("an unknown lease and another node's lease give 409 and write nothing", async () => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1));
    const [lease] = await claim(t1);
    for (const [body, token] of [
      [{ lease_id: "unknown-lease-id", outcome: "error", transcript: null }, t1],
      [okResult(lease as Claimed), t2],
    ] as const) {
      const response = await post("/node/result", body, token);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "stale_lease" } });
    }
    expect(await objects()).toBe(0);
    expect(await count("node_events")).toBe(0);
    expect(await job(vid(1))).toMatchObject({ status: "leased", leased_by: "n1" });
    expect(events("job.stale_result")).toHaveLength(2);
    expect(events("job.stale_result")[1]).toMatchObject({ video_id: vid(1), attrs: { node_id: "n2" } });
  });

  test("a result for a released lease gives 409", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    await post("/node/release", { lease_id: lease?.lease_id }, token);
    expect((await post("/node/result", okResult(lease as Claimed), token)).status).toBe(409);
    expect(await objects()).toBe(0);
  });
});

describe("lease expiry", () => {
  test("an expired lease requeues the job, and the late result gets 409 and writes nothing", async () => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1));
    const [lease] = await claim(t1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(lease?.lease_expires_at ?? "") + 1);

    const late = await post("/node/result", okResult(lease as Claimed), t1);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: { code: "stale_lease" } });
    expect(await objects()).toBe(0);
    expect(await leaseState(lease as Claimed)).toBe("expired");
    expect(await job(vid(1))).toMatchObject({ status: "queued", attempts: 1, tried_nodes: ["n1"], last_outcome: "lease_expired", leased_by: null });
    expect(await count("node_events", "kind = 'lease_expired' AND node_id = 'n1'")).toBe(1);
    expect(events("job.lease_expired")).toMatchObject([{ video_id: vid(1), attrs: { node_id: "n1", attempts: 1, status: "queued" } }]);
    expect(events("job.stale_result")).toHaveLength(1);

    const [again] = await claim(t2);
    expect(again?.video_id).toBe(vid(1));
    expect(await claim(t1)).toEqual([]);
  });

  test("a lease expires exactly at lease_expires_at, not a millisecond before", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const expiry = Date.parse(lease?.lease_expires_at ?? "");
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(expiry - 1);
    expect((await job(vid(1))).status).toBe("leased");
    vi.setSystemTime(expiry);
    expect(await job(vid(1))).toMatchObject({ status: "queued", last_outcome: "lease_expired" });
  });

  test("a result one millisecond before expiry is accepted; at the expiry it is stale", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1), vid(2));
    const [first, second] = await claim(token, 2);
    const expiry = Date.parse(first?.lease_expires_at ?? "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(expiry - 1);
    expect((await post("/node/result", failure(first as Claimed, "no_transcript"), token)).status).toBe(200);
    vi.setSystemTime(Date.parse(second?.lease_expires_at ?? ""));
    expect((await post("/node/result", failure(second as Claimed, "no_transcript"), token)).status).toBe(409);
  });

  test("each /node/* request sweeps; the third expiry gives failed_video", async () => {
    const tokens = await Promise.all(["n1", "n2", "n3"].map(enroll));
    await enqueue(vid(1));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T07:00:00.000Z"));
    for (const [i, token] of tokens.entries()) {
      expect(await claim(token)).toHaveLength(1);
      vi.setSystemTime(Date.now() + 2000);
      const heartbeat = await post("/node/heartbeat", { version: "1", uptime_s: 0, jobs_in_progress: 0 }, tokens[(i + 1) % 3]);
      expect(heartbeat.status).toBe(200);
      expect((await job(vid(1))).status).toBe(i === 2 ? "failed_video" : "queued");
    }
    expect(events("job.lease_expired").map((line) => (line.attrs as { status: string }).status)).toEqual(["queued", "queued", "failed_video"]);
    expect(await job(vid(1))).toMatchObject({ attempts: 3, last_outcome: "lease_expired" });
  });

  test("an unexpired lease is left alone by the sweep", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    await claim(token);
    expect(await job(vid(1))).toMatchObject({ status: "leased", leased_by: "n1" });
    expect(await count("node_events")).toBe(0);
  });
});

describe("POST /node/release", () => {
  test("undoes the claim and is idempotent", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const first = await post("/node/release", { lease_id: lease?.lease_id }, token);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ video_id: vid(1), status: "queued" });
    expect(await job(vid(1))).toMatchObject({ status: "queued", leased_by: null, lease_expires_at: null, attempts: 0, tried_nodes: [], last_outcome: "released" });
    const row = await env.DB.prepare("SELECT lease_id FROM jobs").first<{ lease_id: string | null }>();
    expect(row?.lease_id).toBeNull();
    expect(await leaseState(lease as Claimed)).toBe("released");
    expect(await count("node_events")).toBe(0);

    const again = await post("/node/release", { lease_id: lease?.lease_id }, token);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ video_id: vid(1), status: "queued" });
    expect(events("job.released")).toMatchObject([{ video_id: vid(1), attrs: { node_id: "n1" } }]);

    const [reclaimed] = await claim(token);
    expect(reclaimed?.video_id).toBe(vid(1));
    expect(reclaimed?.lease_id).not.toBe(lease?.lease_id);
    expect(await job(vid(1))).toMatchObject({ attempts: 1, tried_nodes: ["n1"] });
  });

  test("only removes the releasing node from tried_nodes", async () => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1));
    const [first] = await claim(t1);
    await post("/node/result", failure(first as Claimed, "error"), t1);
    const [second] = await claim(t2);
    await post("/node/release", { lease_id: second?.lease_id }, t2);
    expect(await job(vid(1))).toMatchObject({ status: "queued", attempts: 1, tried_nodes: ["n1"] });
  });

  test("a lease that is unknown, another node's, completed, expired, revoked or rejected gives 409", async () => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1), vid(2), vid(3), vid(4));
    const [done, expired, rejected, other] = await claim(t1, 4);
    await post("/node/result", failure(done as Claimed, "no_transcript"), t1);
    await post("/node/result", okResult(rejected as Claimed, { word_count: 0 }), t1);
    await env.DB.prepare("UPDATE leases SET state = 'expired' WHERE lease_id = ?1").bind(expired?.lease_id).run();
    await env.DB.prepare("UPDATE leases SET state = 'revoked' WHERE lease_id = ?1").bind(other?.lease_id).run();
    for (const [id, token] of [["unknown-lease-id", t1], [done?.lease_id, t1], [expired?.lease_id, t1], [rejected?.lease_id, t1], [other?.lease_id, t1], [other?.lease_id, t2]]) {
      const response = await post("/node/release", { lease_id: id }, token);
      expect(response.status, String(id)).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: "stale_lease" } });
    }
  });

  test.each([{}, { lease_id: "" }, { lease_id: 1 }, { lease_id: "x", extra: 1 }])("rejects %j", async (body) => {
    const token = await enroll("n1");
    expect((await post("/node/release", body, token)).status).toBe(400);
  });
});

describe("node authentication on result and release", () => {
  test.each(["/node/result", "/node/release"])("%s: no bearer, unknown token and operator token give 401", async (path) => {
    await enroll("n1");
    for (const token of [undefined, "ytd_node_unknown", "ops-test"]) {
      expect((await post(path, {}, token)).status).toBe(401);
    }
  });
});

describe("DELETE /ops/nodes/<node_id>", () => {
  test("disables the node, refuses its token and reassigns its jobs", async () => {
    const t1 = await enroll("n1");
    const t2 = await enroll("n2");
    await enqueue(vid(1), vid(2));
    const leases = await claim(t1, 2);
    const response = await ops("/ops/nodes/n1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ node_id: "n1", state: "disabled" });
    const row = await env.DB.prepare("SELECT state, revoked_at FROM nodes WHERE node_id = 'n1'").first<{ state: string; revoked_at: string | null }>();
    expect(row?.state).toBe("disabled");
    expect(row?.revoked_at).toMatch(/Z$/);

    for (const lease of leases) {
      expect(await leaseState(lease)).toBe("revoked");
      expect((await post("/node/result", okResult(lease), t1)).status).toBe(401);
    }
    expect((await post("/node/claim", {}, t1)).status).toBe(401);
    expect(await job(vid(1))).toMatchObject({ status: "queued", leased_by: null, attempts: 1, tried_nodes: ["n1"], last_outcome: "lease_revoked" });
    expect(events("node.revoked")).toMatchObject([{ attrs: { node_id: "n1", leases_revoked: 2 } }]);
    expect(await objects()).toBe(0);
    expect((await claim(t2, 5)).map((l) => l.video_id)).toEqual([vid(1), vid(2)]);
  });

  test("is idempotent, and 404 for an unknown node", async () => {
    await enroll("n1");
    const first = await ops("/ops/nodes/n1", { method: "DELETE" });
    const before = await env.DB.prepare("SELECT revoked_at FROM nodes").first<{ revoked_at: string }>();
    const again = await ops("/ops/nodes/n1", { method: "DELETE" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(await first.json());
    expect((await env.DB.prepare("SELECT revoked_at FROM nodes").first<{ revoked_at: string }>())?.revoked_at).toBe(before?.revoked_at);
    expect(events("node.revoked")).toHaveLength(1);
    const unknown = await ops("/ops/nodes/nobody", { method: "DELETE" });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: "not_found" } });
  });

  test("a revoked node's third attempt gives failed_video", async () => {
    const [t1, t2, t3] = await Promise.all(["n1", "n2", "n3"].map(enroll));
    await enqueue(vid(1));
    const [first] = await claim(t1 as string);
    await post("/node/result", failure(first as Claimed, "error"), t1);
    const [second] = await claim(t2 as string);
    await post("/node/result", failure(second as Claimed, "error"), t2);
    await claim(t3 as string);
    await ops("/ops/nodes/n3", { method: "DELETE" });
    expect(await job(vid(1))).toMatchObject({ status: "failed_video", attempts: 3, last_outcome: "lease_revoked" });
  });

  test("needs the operator bearer", async () => {
    await enroll("n1");
    expect((await call("/ops/nodes/n1", { method: "DELETE" })).status).toBe(401);
    expect((await env.DB.prepare("SELECT revoked_at FROM nodes").first<{ revoked_at: string | null }>())?.revoked_at).toBeNull();
  });
});

describe("concurrency", () => {
  test("two identical results at once give the same answer and one event", async () => {
    const token = await enroll("n1");
    await enqueue(vid(1));
    const [lease] = await claim(token);
    const answers = await Promise.all([1, 2, 3].map(() => post("/node/result", failure(lease as Claimed, "error"), token)));
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(await Promise.all(answers.map((r) => r.text()))).size).toBe(1);
    expect(await count("node_events")).toBe(1);
    expect(await job(vid(1))).toMatchObject({ status: "queued", attempts: 1 });
  });
});
