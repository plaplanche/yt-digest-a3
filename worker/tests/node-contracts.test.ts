import { describe, expect, expectTypeOf, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import draft7Meta from "ajv/dist/refs/json-schema-draft-07.json" with { type: "json" };
import type { NodeResultRequest } from "../src/contracts/node-result-request";
import type { TranscriptResult } from "../src/contracts/transcript-result";

const dir = new URL("../../contracts/", import.meta.url).pathname;
const ajv = new Ajv2020({ strict: false });
ajv.addMetaSchema(draft7Meta);
for (const file of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(`${dir}${file}`, "utf8")) as object, file);
}
const accepts = (schema: string, value: unknown): boolean => (ajv.getSchema(`${schema}.schema.json`) ?? fail(schema))(value) === true;
const fail = (name: string): never => {
  throw new Error(`no schema ${name}`);
};

const transcript = {
  video_id: "dQw4w9WgXcQ",
  status: "ok",
  lang: "en",
  source: "manual",
  word_count: 3,
  truncated: false,
  sponsor_ratio: null,
  pages: ["one two three"],
};
const heartbeat = { version: "0.1.0", uptime_s: 12, jobs_in_progress: 0 };
const result = { lease_id: "l1", outcome: "ok", transcript };

const valid: [string, unknown][] = [
  ["node-heartbeat-request", heartbeat],
  [
    "node-heartbeat-request",
    { ...heartbeat, last_success_at: "2026-10-16T07:00:01.123Z", last_blocked_at: null, disk_free_ratio: 0.5, cpu_temp_c: 41.5 },
  ],
  ["node-heartbeat-response", { node_id: "n1", state: "healthy", hourly_budget: 5, directive: "run" }],
  ["node-claim-request", {}],
  ["node-claim-request", { max_jobs: 10 }],
  ["node-claim-response", { jobs: [] }],
  [
    "node-claim-response",
    { jobs: [{ video_id: "dQw4w9WgXcQ", lease_id: "0123456789abcdef", lease_expires_at: "2026-10-16T07:00:01.123Z" }] },
  ],
  ["node-result-request", result],
  ["node-result-request", { ...result, outcome: "error", transcript: null }],
  ["node-release-request", { lease_id: "l1" }],
  ["node-job-ack", { video_id: "dQw4w9WgXcQ", status: "done" }],
  ["error", { error: { code: "stale_lease", message: "no such lease" } }],
];

const invalid: [string, unknown][] = [
  ["node-heartbeat-request", { ...heartbeat, extra: 1 }],
  ["node-heartbeat-request", { uptime_s: 1, jobs_in_progress: 0 }],
  ["node-heartbeat-request", { ...heartbeat, version: "" }],
  ["node-heartbeat-request", { ...heartbeat, uptime_s: -1 }],
  ["node-heartbeat-request", { ...heartbeat, disk_free_ratio: 1.1 }],
  ["node-heartbeat-request", { ...heartbeat, last_success_at: "yesterday" }],
  ["node-heartbeat-response", { node_id: "n1", state: "sick", hourly_budget: 5, directive: "run" }],
  ["node-claim-request", { extra: 1 }],
  ["node-claim-request", { max_jobs: 0 }],
  ["node-claim-request", { max_jobs: 11 }],
  ["node-claim-response", { jobs: [{ video_id: "dQw4w9WgXcQ", lease_id: "short" }] }],
  ["node-result-request", { ...result, extra: 1 }],
  ["node-result-request", { ...result, outcome: "weird" }],
  ["node-result-request", { ...result, transcript: { ...transcript, extra: 1 } }],
  ["node-result-request", { ...result, transcript: { ...transcript, video_id: "x" } }],
  ["node-result-request", { lease_id: "l1", outcome: "error" }],
  ["node-release-request", { lease_id: "" }],
  ["node-job-ack", { video_id: "dQw4w9WgXcQ", status: "failed" }],
  ["error", { error: { code: "x" } }],
  ["error", { error: { code: "x", message: "y", extra: 1 } }],
];

describe("node protocol schemas", () => {
  test.each(valid)("%s accepts a valid instance", (schema, value) => {
    expect(accepts(schema, value)).toBe(true);
  });
  test.each(invalid)("%s rejects an invalid instance", (schema, value) => {
    expect(accepts(schema, value)).toBe(false);
  });
});

describe("generated result request", () => {
  test("uses the generated transcript-result type without redefining it", () => {
    const source = readFileSync(new URL("../src/contracts/node-result-request.ts", import.meta.url), "utf8");
    expect(source).toContain('import type { TranscriptResult } from "./transcript-result";');
    expect(source).not.toMatch(/interface TranscriptResult/);
    expectTypeOf<NodeResultRequest["transcript"]>().toEqualTypeOf<TranscriptResult | null>();
  });
});
