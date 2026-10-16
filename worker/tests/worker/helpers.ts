import { env } from "cloudflare:workers";
import worker from "../../src/index";
import type { Env } from "../../src/env";

export const OPS_TOKEN = "ops-test";

/** Sends a request to the Worker with the real D1 and R2 bindings and the given settings. */
export function call(path: string, init: RequestInit = {}, settings: Partial<Env> = { OPS_TOKEN }): Promise<Response> {
  const bound: Env = { DB: env.DB, TRANSCRIPTS: env.TRANSCRIPTS, ...settings };
  return worker.fetch(new Request(`http://worker.test${path}`, init), bound);
}

export const ops = (path: string, init: RequestInit = {}): Promise<Response> =>
  call(path, { ...init, headers: { Authorization: `Bearer ${OPS_TOKEN}` } });
