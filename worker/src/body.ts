import { invalidRequest } from "./http";

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type Fields = Record<string, unknown>;

/** Parses a JSON object body, or returns the 400 response. */
export async function readObject(request: Request): Promise<Fields | Response> {
  let value: unknown;
  try {
    value = JSON.parse(await request.text());
  } catch {
    return invalidRequest("Body is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidRequest("Body must be a JSON object");
  }
  return value as Fields;
}

/** Names of the fields that are not in `allowed`. */
export const unknownFields = (fields: Fields, allowed: readonly string[]): string[] => Object.keys(fields).filter((k) => !allowed.includes(k));

export const isInteger = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export const isTimestamp = (value: unknown): value is string => typeof value === "string" && TIMESTAMP.test(value);

export const isText = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" && value.length >= min && value.length <= max;
