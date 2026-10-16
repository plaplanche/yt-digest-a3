import { expect, type APIRequestContext } from "@playwright/test";
import { workerUrl } from "./stack";

export const opsHeaders = { Authorization: `Bearer ${process.env.OPS_TOKEN ?? "ops-local"}` };

export interface Claimed {
  video_id: string;
  lease_id: string;
  lease_expires_at: string;
}

export const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

export async function reset(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${workerUrl}/ops/reset`, { headers: opsHeaders })).status()).toBe(200);
}

export async function enroll(request: APIRequestContext, nodeId: string, ownerLabel = "e2e"): Promise<string> {
  const response = await request.post(`${workerUrl}/ops/nodes`, { headers: opsHeaders, data: { node_id: nodeId, owner_label: ownerLabel } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

export async function enqueue(request: APIRequestContext, ids: string[]): Promise<void> {
  const response = await request.post(`${workerUrl}/ops/jobs`, { headers: opsHeaders, data: { video_ids: ids } });
  expect(response.status()).toBe(200);
}

export async function claim(request: APIRequestContext, token: string, maxJobs = 3): Promise<Claimed[]> {
  const response = await request.post(`${workerUrl}/node/claim`, { headers: bearer(token), data: { max_jobs: maxJobs } });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { jobs: Claimed[] }).jobs;
}

export const sendResult = (request: APIRequestContext, token: string, leaseId: string, outcome: string, transcript: unknown = null) =>
  request.post(`${workerUrl}/node/result`, { headers: bearer(token), data: { lease_id: leaseId, outcome, transcript } });

export const okTranscript = (videoId: string, text = "hello brave new world"): Record<string, unknown> => ({
  video_id: videoId,
  status: "ok",
  lang: "en",
  source: "manual",
  word_count: text.split(/\s+/).length,
  truncated: false,
  sponsor_ratio: null,
  pages: [text],
});

export async function getJob(request: APIRequestContext, videoId: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${workerUrl}/ops/jobs/${videoId}`, { headers: opsHeaders });
  expect(response.status()).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
