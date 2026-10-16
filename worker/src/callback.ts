import type { Env } from "./env";
import { errorPage, refusalPage } from "./html";
import { log } from "./log";
import { baseUrl, googleEndpoint, redirectTo } from "./oauth";
import { encryptSecret, randomToken, sha256Hex } from "./tokens";

const DEFAULT_AUTH_CODE_TTL_SECONDS = 60;

interface PendingRow {
  client_id: string;
  redirect_uri: string;
  client_state: string | null;
  code_challenge: string;
  scope: string;
  resource: string;
  google_nonce: string | null;
}

interface Identity {
  sub: string;
  email: string;
  emailVerified: boolean;
  refreshToken: string | null;
}

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const decodeJson = (part: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(part)));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return value as Record<string, unknown>;
};

/** Verifies the ID token (RS256 signature against the JWKS, iss, aud, exp, nonce) and returns its identity claims; throws on any failure. */
async function verifyIdToken(env: Env, idToken: string, nonce: string): Promise<Omit<Identity, "refreshToken">> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart);
  if (header.alg !== "RS256") throw new Error("bad alg");
  const jwksResponse = await fetch(await googleEndpoint(env, "jwks_uri"));
  if (!jwksResponse.ok) throw new Error("jwks unavailable");
  const keys = ((await jwksResponse.json()) as { keys?: (JsonWebKey & { kid?: string })[] }).keys ?? [];
  const jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (jwk === undefined) throw new Error("unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromBase64Url(signaturePart), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  if (!valid) throw new Error("bad signature");
  const claims = decodeJson(payloadPart);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== env.GOOGLE_ISSUER) throw new Error("bad iss");
  if (!audiences.includes(env.GOOGLE_CLIENT_ID)) throw new Error("bad aud");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw new Error("expired");
  if (claims.nonce !== nonce) throw new Error("bad nonce");
  if (typeof claims.sub !== "string" || claims.sub === "" || typeof claims.email !== "string") throw new Error("missing claims");
  return { sub: claims.sub, email: claims.email.toLowerCase(), emailVerified: claims.email_verified === true };
}

async function identify(env: Env, code: string, nonce: string): Promise<Identity> {
  const response = await fetch(await googleEndpoint(env, "token_endpoint"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${baseUrl(env)}/callback`,
      client_id: env.GOOGLE_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    }),
  });
  if (!response.ok) throw new Error(`token endpoint ${response.status}`);
  const tokens = (await response.json()) as { id_token?: unknown; refresh_token?: unknown };
  if (typeof tokens.id_token !== "string") throw new Error("no id_token");
  const identity = await verifyIdToken(env, tokens.id_token, nonce);
  return { ...identity, refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : null };
}

export async function callback(request: Request, env: Env): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");
  const now = new Date().toISOString();
  const pending =
    state === null || state === ""
      ? null
      : await env.DB.prepare(
          "UPDATE oauth_requests SET used_at = ?2 WHERE google_state = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING client_id, redirect_uri, client_state, code_challenge, scope, resource, google_nonce",
        )
          .bind(state, now)
          .first<PendingRow>();
  if (pending === null) return errorPage(400, "This sign-in is unknown, expired or already used.");
  const fail = (reason: "google_error", error: string): Response => {
    log("auth.oauth.denied", { attrs: { client_id: pending.client_id, reason } });
    return redirectTo(pending.redirect_uri, { error }, pending.client_state);
  };

  if (query.has("error")) return fail("google_error", "access_denied");
  let identity: Identity;
  try {
    const code = query.get("code");
    if (code === null || code === "" || pending.google_nonce === null) throw new Error("missing code");
    identity = await identify(env, code, pending.google_nonce);
  } catch {
    return fail("google_error", "server_error");
  }

  const denied = (reason: "not_invited" | "email_unverified"): Response => {
    log("auth.oauth.denied", { attrs: { client_id: pending.client_id, reason } });
    return refusalPage();
  };
  if (!identity.emailVerified) return denied("email_unverified");
  const isAdmin = identity.email === (env.ADMIN_EMAIL ?? "").toLowerCase();
  const invite = await env.DB.prepare("SELECT email FROM invites WHERE email = ?1 AND revoked = 0").bind(identity.email).first();
  if (!isAdmin && invite === null) return denied("not_invited");
  const role = isAdmin ? "admin" : "member";

  const encrypted = identity.refreshToken === null ? null : await encryptSecret(identity.refreshToken, env.TOKEN_ENC_KEY ?? "");
  const authCode = randomToken(32);
  const ttl = Number(env.AUTH_CODE_TTL_SECONDS ?? DEFAULT_AUTH_CODE_TTL_SECONDS);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (user_sub, email, role, google_refresh_token_enc, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (user_sub) DO UPDATE SET email = ?2, role = ?3, google_refresh_token_enc = COALESCE(?4, google_refresh_token_enc)",
    ).bind(identity.sub, identity.email, role, encrypted, now),
    env.DB.prepare("UPDATE invites SET accepted_user_sub = ?2 WHERE email = ?1 AND revoked = 0").bind(identity.email, identity.sub),
    env.DB.prepare(
      "INSERT INTO oauth_codes (code_hash, client_id, user_sub, redirect_uri, code_challenge, scope, resource, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(await sha256Hex(authCode), pending.client_id, identity.sub, pending.redirect_uri, pending.code_challenge, pending.scope, pending.resource, new Date(Date.now() + ttl * 1000).toISOString()),
  ]);
  log("auth.oauth.completed", { attrs: { client_id: pending.client_id, role } });
  return redirectTo(pending.redirect_uri, { code: authCode }, pending.client_state);
}
