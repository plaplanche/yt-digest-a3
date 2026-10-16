import type { ErrorBody } from "./contracts/error";

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function error(status: number, code: string, message: string): Response {
  const body: ErrorBody = { error: { code, message } };
  return json(body, status);
}

export const notFound = (): Response => error(404, "not_found", "Not found");
export const invalidRequest = (message: string): Response => error(400, "invalid_request", message);
export const unauthorized = (): Response => error(401, "unauthorized", "Missing or invalid bearer token");

/** Compares two strings in constant time with respect to their content (both are hashed to equal length first). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([a, b].map(async (s) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
  return crypto.subtle.timingSafeEqual(ha as ArrayBuffer, hb as ArrayBuffer);
}

export function bearer(request: Request): string | null {
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return match?.[1] ?? null;
}
