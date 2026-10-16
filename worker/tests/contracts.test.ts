import { describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { LogEventName } from "../src/contracts/log-event";
import { log } from "../src/log";

const schemaPath = (name: string): string => new URL(`../../contracts/${name}.schema.json`, import.meta.url).pathname;

interface Schema {
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, { pattern?: string; enum?: unknown[] }>;
}
const resultSchema = JSON.parse(readFileSync(schemaPath("transcript-result"), "utf8")) as Schema;

describe("transcript result schema", () => {
  test("forbids extra fields and constrains video_id", () => {
    expect(resultSchema.additionalProperties).toBe(false);
    const pattern = new RegExp(resultSchema.properties.video_id.pattern ?? "");
    expect(pattern.test("dQw4w9WgXcQ")).toBe(true);
    expect(pattern.test("short")).toBe(false);
    expect(pattern.test("bad id/chars")).toBe(false);
  });
  test("lists the four statuses", () => {
    expect(resultSchema.properties.status.enum).toEqual(["ok", "no_transcript", "unavailable", "blocked"]);
  });
});

describe("log", () => {
  test("writes a valid line", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log("service.started", { attrs: { version: "0.1.0" }, request_id: "r1" });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    spy.mockRestore();
    expect(line).toMatchObject({ level: "info", service: "worker", event: "service.started", request_id: "r1" });
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
  test("accepts a lot 2 event", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    log("job.claimed", { video_id: "dQw4w9WgXcQ", attrs: { node_id: "n1" } });
    const line = JSON.parse(String(spy.mock.calls[0]?.[0])) as Record<string, unknown>;
    spy.mockRestore();
    expect(line).toMatchObject({ event: "job.claimed", video_id: "dQw4w9WgXcQ" });
  });
  test("throws for an event outside the catalogue", () => {
    expect(() => log("nope.event" as LogEventName)).toThrow("unknown log event");
  });
  test("throws for an unknown field or level", () => {
    expect(() => log("service.started", { extra: 1 } as never)).toThrow("unknown log field");
    expect(() => log("service.started", { level: "loud" } as never)).toThrow("unknown log level");
  });
  test("rejects an unknown event at type level", () => {
    // @ts-expect-error not in the catalogue
    expect(() => log("nope.event")).toThrow();
  });
});
