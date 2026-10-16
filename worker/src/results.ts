import type { NodeJobAck } from "./contracts/node-job-ack";
import type { NodeResultRequest } from "./contracts/node-result-request";
import type { TranscriptResult } from "./contracts/transcript-result";
import { VIDEO_ID, isInteger, isText, readObject, unknownFields, type Fields } from "./body";
import type { Env } from "./env";
import { error, invalidRequest, json } from "./http";
import { endDone, endFailed, failedStatus, release, sweepExpired, type LeaseRow } from "./leases";
import { log } from "./log";
import type { NodeRow } from "./nodes";

const OUTCOMES = ["ok", "no_transcript", "unavailable", "blocked", "error"];
const TRANSCRIPT_FIELDS = ["video_id", "status", "lang", "source", "word_count", "truncated", "sponsor_ratio", "pages"];
const MARKER = "[…]";

export const transcriptKey = (videoId: string): string => `transcripts/${videoId}.json`;

/** Mirrors `transcript-result.schema.json`. */
function transcriptSchemaError(value: Fields): string | null {
  if (unknownFields(value, TRANSCRIPT_FIELDS).length > 0) return "Unknown transcript field";
  if (typeof value.video_id !== "string" || !VIDEO_ID.test(value.video_id)) return "Invalid transcript video_id";
  if (!["ok", "no_transcript", "unavailable", "blocked"].includes(value.status as string)) return "Invalid transcript status";
  if (value.lang !== null && typeof value.lang !== "string") return "transcript lang must be a string or null";
  if (value.source !== null && value.source !== "manual" && value.source !== "auto") return "Invalid transcript source";
  if (!isInteger(value.word_count, 0)) return "transcript word_count must be an integer >= 0";
  if (typeof value.truncated !== "boolean") return "transcript truncated must be a boolean";
  const ratio = value.sponsor_ratio;
  if (ratio !== null && !(typeof ratio === "number" && ratio >= 0 && ratio <= 1)) return "transcript sponsor_ratio must be in [0, 1] or null";
  if (!Array.isArray(value.pages) || !value.pages.every((page) => typeof page === "string")) return "transcript pages must be strings";
  return null;
}

function parseResult(body: Fields): NodeResultRequest | string {
  if (unknownFields(body, ["lease_id", "outcome", "transcript"]).length > 0) return "Unknown field";
  if (!isText(body.lease_id, 1, Number.MAX_SAFE_INTEGER)) return "lease_id must be a non-empty string";
  if (typeof body.outcome !== "string" || !OUTCOMES.includes(body.outcome)) return "Invalid outcome";
  const transcript = body.transcript;
  if (transcript === undefined) return "transcript is required";
  if (transcript !== null) {
    if (typeof transcript !== "object" || Array.isArray(transcript)) return "transcript must be an object or null";
    const problem = transcriptSchemaError(transcript as Fields);
    if (problem !== null) return problem;
  }
  return body as unknown as NodeResultRequest;
}

/** 8.4 step 3: the rules the schema cannot hold; null when the result is consistent. */
function validationProblem(request: NodeResultRequest, videoId: string): string | null {
  const { transcript } = request;
  if (request.outcome !== "ok") return transcript === null ? null : "transcript must be null unless the outcome is ok";
  if (transcript === null) return "transcript is required for the outcome ok";
  if (transcript.status !== "ok") return "transcript status must be ok";
  if (transcript.video_id !== videoId) return "transcript video_id is not the job's";
  if (transcript.pages.length === 0) return "transcript pages must not be empty";
  const words = transcript.pages.flatMap((page) => page.split(/\s+/)).filter((word) => word !== "" && word !== MARKER).length;
  if (transcript.word_count !== words) return "transcript word_count does not match its pages";
  return null;
}

const stale = (): Response => error(409, "stale_lease", "The lease is not the node's current lease");

/**
 * The lease of a request when it is active and the node's; otherwise the response to give: the stored
 * answer of a lease already in the `replay` state, or 409.
 */
async function currentLease(env: Env, node: NodeRow, leaseId: string, replay: "completed" | "released", onStale?: (lease: LeaseRow | null) => void): Promise<LeaseRow | Response> {
  const lease = await env.DB.prepare("SELECT lease_id, video_id, node_id, state, response_json FROM leases WHERE lease_id = ?1").bind(leaseId).first<LeaseRow>();
  if (lease !== null && lease.node_id === node.node_id) {
    if (lease.state === "active") return lease;
    if (lease.state === replay && lease.response_json !== null) return new Response(lease.response_json, { status: 200, headers: { "Content-Type": "application/json" } });
  }
  onStale?.(lease);
  return stale();
}

/** The answer when another request ended the lease between our check and our write. */
async function lostRace(env: Env, node: NodeRow, leaseId: string, replay: "completed" | "released"): Promise<Response> {
  const current = await currentLease(env, node, leaseId, replay);
  return current instanceof Response ? current : stale();
}

export async function result(request: Request, env: Env, node: NodeRow): Promise<Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  const parsed = parseResult(body);
  if (typeof parsed === "string") return invalidRequest(parsed);
  await sweepExpired(env);

  const lease = await currentLease(env, node, parsed.lease_id, "completed", (found) =>
    log("job.stale_result", { ...(found !== null && { video_id: found.video_id }), attrs: { node_id: node.node_id } }),
  );
  if (lease instanceof Response) return lease;
  const now = new Date().toISOString();
  const job = await env.DB.prepare("SELECT attempts FROM jobs WHERE video_id = ?1 AND kind = 'primary'").bind(lease.video_id).first<{ attempts: number }>();
  const attempts = job?.attempts ?? 0;

  const problem = validationProblem(parsed, lease.video_id);
  if (problem !== null) {
    const ended = await endFailed(env, lease, { now, leaseState: "rejected", outcome: "validation_failed", eventKind: "validation_failed", response: null });
    if (!ended) return lostRace(env, node, parsed.lease_id, "completed");
    log("job.validation_failed", { video_id: lease.video_id, attrs: { node_id: node.node_id, reason: problem } });
    return error(422, "validation_failed", problem);
  }

  const outcome = parsed.outcome;
  const ack: NodeJobAck = { video_id: lease.video_id, status: outcome === "ok" || outcome === "no_transcript" ? "done" : failedStatus(attempts) };
  const ending = { now, leaseState: "completed", outcome, eventKind: `job_${outcome}`, response: ack } as const;
  if (outcome === "ok") {
    if (!(await store(env, lease, node, parsed.transcript as TranscriptResult, now))) {
      return error(503, "storage_error", "The transcript could not be stored");
    }
  }
  const ended = ack.status === "done" ? await endDone(env, lease, ending) : await endFailed(env, lease, ending);
  if (!ended) return lostRace(env, node, parsed.lease_id, "completed");
  log("job.completed", { video_id: lease.video_id, attrs: { node_id: node.node_id, outcome, status: ack.status } });
  return json(ack);
}

/** 6.4: writes the transcript unless an object exists; false when R2 fails. */
async function store(env: Env, lease: LeaseRow, node: NodeRow, transcript: TranscriptResult, producedAt: string): Promise<boolean> {
  try {
    await env.TRANSCRIPTS.put(transcriptKey(lease.video_id), JSON.stringify(transcript), {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { node_id: node.node_id, lease_id: lease.lease_id, produced_at: producedAt },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    return true;
  } catch {
    return false;
  }
}

export async function releaseJob(request: Request, env: Env, node: NodeRow): Promise<Response> {
  const body = await readObject(request);
  if (body instanceof Response) return body;
  if (unknownFields(body, ["lease_id"]).length > 0) return invalidRequest("Unknown field");
  if (!isText(body.lease_id, 1, Number.MAX_SAFE_INTEGER)) return invalidRequest("lease_id must be a non-empty string");
  await sweepExpired(env);

  const leaseId = body.lease_id;
  const lease = await currentLease(env, node, leaseId, "released");
  if (lease instanceof Response) return lease;
  const ack: NodeJobAck = { video_id: lease.video_id, status: "queued" };
  if (!(await release(env, lease, ack))) return lostRace(env, node, leaseId, "released");
  log("job.released", { video_id: lease.video_id, attrs: { node_id: node.node_id } });
  return json(ack);
}
