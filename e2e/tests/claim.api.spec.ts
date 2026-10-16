import { expect, test, type APIRequestContext } from "@playwright/test";
import { workerUrl } from "./stack";

const opsHeaders = { Authorization: `Bearer ${process.env.OPS_TOKEN ?? "ops-local"}` };

interface Claimed {
  video_id: string;
  lease_id: string;
  lease_expires_at: string;
}

async function enroll(request: APIRequestContext, nodeId: string): Promise<string> {
  const response = await request.post(`${workerUrl}/ops/nodes`, { headers: opsHeaders, data: { node_id: nodeId, owner_label: "e2e" } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${workerUrl}/ops/reset`, { headers: opsHeaders })).status()).toBe(200);
});

test("2 nodes claim 6 jobs concurrently and each job is handed out once", async ({ request }) => {
  const tokens = await Promise.all([enroll(request, "node-a"), enroll(request, "node-b")]);
  const ids = Array.from({ length: 6 }, (_, i) => `e2eVideo${String(i).padStart(3, "0")}`);
  const enqueued = await request.post(`${workerUrl}/ops/jobs`, { headers: opsHeaders, data: { video_ids: ids } });
  expect((await enqueued.json()) as { enqueued: string[] }).toEqual({ enqueued: ids, existing: [] });

  const answers = await Promise.all(
    tokens.map(async (token) => {
      const response = await request.post(`${workerUrl}/node/claim`, { headers: { Authorization: `Bearer ${token}` }, data: { max_jobs: 6 } });
      expect(response.status()).toBe(200);
      return ((await response.json()) as { jobs: Claimed[] }).jobs;
    }),
  );

  const handedOut = answers.flat().map((job) => job.video_id);
  expect([...handedOut].sort()).toEqual([...ids].sort());
  expect(new Set(answers.flat().map((job) => job.lease_id)).size).toBe(6);
  for (const id of ids) {
    const job = await (await request.get(`${workerUrl}/ops/jobs/${id}`, { headers: opsHeaders })).json();
    expect(job).toMatchObject({ status: "leased", attempts: 1 });
    expect(job.tried_nodes).toHaveLength(1);
  }

  // E2E-13 in full: each node answers its own jobs, and all 6 end done.
  await Promise.all(
    answers.flatMap((jobs, i) =>
      jobs.map(async (leased) => {
        const response = await request.post(`${workerUrl}/node/result`, {
          headers: { Authorization: `Bearer ${tokens[i]}` },
          data: { lease_id: leased.lease_id, outcome: "no_transcript", transcript: null },
        });
        expect(response.status()).toBe(200);
      }),
    ),
  );
  for (const id of ids) {
    const job = await (await request.get(`${workerUrl}/ops/jobs/${id}`, { headers: opsHeaders })).json();
    expect(job).toMatchObject({ status: "done", attempts: 1 });
  }
});
