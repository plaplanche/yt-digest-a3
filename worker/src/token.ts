import type { Env } from "./env";
import { json } from "./http";
import { log } from "./log";
import { baseUrl, oauthError } from "./oauth";
import { base64url, randomToken, sha256Hex } from "./tokens";

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 3600;
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 2592000;

interface CodeRow {
  client_id: string;
  user_sub: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  expires_at: string;
}

interface RefreshRow {
  user_sub: string;
  family_id: string;
  scope: string;
  resource: string;
}

const invalidGrant = (description: string): Response => oauthError(400, "invalid_grant", description);

/** Inserts a new access and refresh token pair of the family in one batch and answers the token response. */
async function issue(env: Env, grantType: string, clientId: string, userSub: string, familyId: string, scope: string, resource: string): Promise<Response> {
  const accessTtl = Number(env.ACCESS_TOKEN_TTL_SECONDS ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
  const refreshTtl = Number(env.REFRESH_TOKEN_TTL_SECONDS ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS);
  const accessToken = randomToken(32);
  const refreshToken = randomToken(32);
  const now = Date.now();
  const insert = "INSERT INTO oauth_tokens (token_hash, kind, client_id, user_sub, family_id, scope, resource, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)";
  await env.DB.batch([
    env.DB.prepare(insert).bind(await sha256Hex(accessToken), "access", clientId, userSub, familyId, scope, resource, new Date(now + accessTtl * 1000).toISOString()),
    env.DB.prepare(insert).bind(await sha256Hex(refreshToken), "refresh", clientId, userSub, familyId, scope, resource, new Date(now + refreshTtl * 1000).toISOString()),
  ]);
  log("auth.token.issued", { attrs: { client_id: clientId, grant_type: grantType } });
  return json(
    { access_token: accessToken, token_type: "Bearer", expires_in: accessTtl, refresh_token: refreshToken, scope },
    200,
    { "Cache-Control": "no-store" },
  );
}

async function exchangeCode(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const code = form.get("code");
  const redirectUri = form.get("redirect_uri");
  const verifier = form.get("code_verifier");
  const resource = form.get("resource");
  if (!code || !redirectUri || !verifier || !resource) return oauthError(400, "invalid_request", "code, redirect_uri, code_verifier and resource are required");
  if (resource !== `${baseUrl(env)}/mcp`) return oauthError(400, "invalid_target", "Unknown resource");

  const now = new Date().toISOString();
  // The code is used up here, whatever the checks below say.
  const row = await env.DB.prepare(
    "UPDATE oauth_codes SET used_at = ?2 WHERE code_hash = ?1 AND used_at IS NULL RETURNING client_id, user_sub, redirect_uri, code_challenge, scope, resource, expires_at",
  )
    .bind(await sha256Hex(code), now)
    .first<CodeRow>();
  if (row === null || row.expires_at <= now) return invalidGrant("The authorization code is unknown, expired or already used");
  if (row.client_id !== clientId) return invalidGrant("The authorization code was issued to another client");
  if (row.redirect_uri !== redirectUri) return invalidGrant("redirect_uri does not match the authorization request");
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  if (challenge !== row.code_challenge) return invalidGrant("code_verifier does not match the code challenge");
  return issue(env, "authorization_code", clientId, row.user_sub, randomToken(24), row.scope, row.resource);
}

async function refresh(env: Env, form: URLSearchParams, clientId: string): Promise<Response> {
  const refreshToken = form.get("refresh_token");
  if (!refreshToken) return oauthError(400, "invalid_request", "refresh_token is required");
  const resource = form.get("resource");
  if (resource !== null && resource !== `${baseUrl(env)}/mcp`) return oauthError(400, "invalid_target", "Unknown resource");

  const hash = await sha256Hex(refreshToken);
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    "UPDATE oauth_tokens SET used_at = ?3 WHERE token_hash = ?1 AND kind = 'refresh' AND client_id = ?2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?3 RETURNING user_sub, family_id, scope, resource",
  )
    .bind(hash, clientId, now)
    .first<RefreshRow>();
  if (row !== null) return issue(env, "refresh_token", clientId, row.user_sub, row.family_id, row.scope, row.resource);

  const known = await env.DB.prepare("SELECT family_id, used_at FROM oauth_tokens WHERE token_hash = ?1 AND kind = 'refresh' AND client_id = ?2")
    .bind(hash, clientId)
    .first<{ family_id: string; used_at: string | null }>();
  if (known?.used_at != null) {
    const revoked = await env.DB.prepare("UPDATE oauth_tokens SET revoked_at = ?2 WHERE family_id = ?1 AND revoked_at IS NULL")
      .bind(known.family_id, now)
      .run();
    log("auth.refresh.reuse_detected", { level: "warn", attrs: { client_id: clientId, revoked: revoked.meta.changes } });
  }
  return invalidGrant("The refresh token is unknown, expired, revoked or already used");
}

/** POST /token (section 10.5). */
export async function token(request: Request, env: Env): Promise<Response> {
  if (!(request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    return oauthError(400, "invalid_request", "The body must be application/x-www-form-urlencoded");
  }
  const form = new URLSearchParams();
  try {
    for (const [name, value] of await request.formData()) if (typeof value === "string") form.append(name, value);
  } catch {
    return oauthError(400, "invalid_request", "The body could not be read as a form");
  }
  const grantType = form.get("grant_type");
  if (grantType === null || grantType === "") return oauthError(400, "invalid_request", "grant_type is required");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") return oauthError(400, "unsupported_grant_type", "Unsupported grant_type");
  const clientId = form.get("client_id");
  if (!clientId) return oauthError(400, "invalid_request", "client_id is required");
  const client = await env.DB.prepare("SELECT client_id FROM oauth_clients WHERE client_id = ?1").bind(clientId).first();
  if (client === null) return oauthError(401, "invalid_client", "Unknown client");
  return grantType === "authorization_code" ? exchangeCode(env, form, clientId) : refresh(env, form, clientId);
}

export interface AccessGrant {
  user_sub: string;
  email: string;
  role: "admin" | "member";
  client_id: string;
}

/**
 * Section 10.6: the grant behind a bearer that is a valid access token, or null.
 * The user's admission (admin e-mail or a live invite) is read again on every call.
 */
export async function checkAccessToken(env: Env, bearer: string): Promise<AccessGrant | null> {
  const admin = (env.ADMIN_EMAIL ?? "").toLowerCase();
  const row = await env.DB.prepare(
    `SELECT t.user_sub, t.client_id, u.email FROM oauth_tokens t JOIN users u ON u.user_sub = t.user_sub
     WHERE t.token_hash = ?1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > ?2 AND t.resource = ?3
       AND (?4 <> '' AND lower(u.email) = ?4 OR EXISTS (SELECT 1 FROM invites i WHERE i.email = lower(u.email) AND i.revoked = 0))`,
  )
    .bind(await sha256Hex(bearer), new Date().toISOString(), `${baseUrl(env)}/mcp`, admin)
    .first<{ user_sub: string; client_id: string; email: string }>();
  if (row === null) return null;
  return { user_sub: row.user_sub, email: row.email, role: row.email.toLowerCase() === admin ? "admin" : "member", client_id: row.client_id };
}
