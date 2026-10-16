import type { Env } from "./env";
import { errorPage, escapeHtml, page } from "./html";
import { json } from "./http";
import { log } from "./log";
import { randomToken } from "./tokens";

const SCOPE = "digest";
const DEFAULT_AUTH_REQUEST_TTL_SECONDS = 600;
const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/youtube.readonly";
const GRANT_TYPES = ["authorization_code", "refresh_token"];

export const baseUrl = (env: Env): string => (env.PUBLIC_URL ?? "").replace(/\/+$/, "");

export const oauthError = (status: number, error: string, description: string): Response =>
  json({ error, error_description: description }, status, { "Cache-Control": "no-store" });

/** The redirect to a client with the given parameters added to its `redirect_uri`; `state` is dropped when the client sent none. */
export function redirectTo(redirectUri: string, params: Record<string, string>, state: string | null): Response {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  if (state !== null) url.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}

export function discovery(env: Env, path: string): Response {
  const base = baseUrl(env);
  if (path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      response_types_supported: ["code"],
      grant_types_supported: GRANT_TYPES,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [SCOPE],
    });
  }
  return json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [SCOPE], bearer_methods_supported: ["header"] });
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("#")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
}

const isSubset = (value: unknown, allowed: string[]): boolean =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && allowed.includes(item));

export async function register(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return oauthError(400, "invalid_client_metadata", "Body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return oauthError(400, "invalid_client_metadata", "Body must be a JSON object");
  }
  const meta = body as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every(validRedirectUri)) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must hold 1 to 10 valid redirect URIs");
  }
  if (uris.length > 10) return oauthError(400, "invalid_client_metadata", "At most 10 redirect_uris");
  const name = meta.client_name;
  if (name !== undefined && (typeof name !== "string" || name.length > 200)) {
    return oauthError(400, "invalid_client_metadata", "client_name must be a string of up to 200 characters");
  }
  if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== "none") {
    return oauthError(400, "invalid_client_metadata", "Only token_endpoint_auth_method none is supported");
  }
  if (meta.grant_types !== undefined && !isSubset(meta.grant_types, GRANT_TYPES)) {
    return oauthError(400, "invalid_client_metadata", "Unsupported grant_types");
  }
  if (meta.response_types !== undefined && !isSubset(meta.response_types, ["code"])) {
    return oauthError(400, "invalid_client_metadata", "Only response_types code is supported");
  }
  const clientId = randomToken(24);
  const now = new Date();
  await env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(clientId, name ?? null, JSON.stringify(uris), now.toISOString())
    .run();
  log("auth.client.registered", { attrs: { client_id: clientId } });
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      ...(name !== undefined && { client_name: name }),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: GRANT_TYPES,
      response_types: ["code"],
    },
    201,
    { "Cache-Control": "no-store" },
  );
}

interface ClientRow {
  client_name: string | null;
  redirect_uris: string;
}

export async function authorize(request: Request, env: Env): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const clientId = query.get("client_id");
  const client = clientId === null ? null : await env.DB.prepare("SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = ?1").bind(clientId).first<ClientRow>();
  if (clientId === null || client === null) return errorPage(400, "Unknown client.");
  const redirectUri = query.get("redirect_uri");
  if (redirectUri === null || !(JSON.parse(client.redirect_uris) as string[]).includes(redirectUri)) {
    return errorPage(400, "The redirect URI is not registered for this client.");
  }
  const state = query.get("state");
  const refuse = (error: string): Response => redirectTo(redirectUri, { error }, state);
  if (query.get("response_type") !== "code") return refuse("unsupported_response_type");
  const challenge = query.get("code_challenge");
  if (challenge === null || challenge === "" || query.get("code_challenge_method") !== "S256") return refuse("invalid_request");
  if (query.get("resource") !== `${baseUrl(env)}/mcp`) return refuse("invalid_target");
  const scope = query.get("scope") ?? SCOPE;
  if (scope !== SCOPE) return refuse("invalid_scope");

  const requestId = randomToken(24);
  const ttl = Number(env.AUTH_REQUEST_TTL_SECONDS ?? DEFAULT_AUTH_REQUEST_TTL_SECONDS);
  await env.DB.prepare(
    "INSERT INTO oauth_requests (request_id, client_id, redirect_uri, client_state, code_challenge, scope, resource, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(requestId, clientId, redirectUri, state, challenge, scope, `${baseUrl(env)}/mcp`, new Date(Date.now() + ttl * 1000).toISOString())
    .run();
  const name = client.client_name !== null && client.client_name !== "" ? client.client_name : clientId;
  return page(
    200,
    "Authorize access",
    `<h1>Authorize access</h1>
<p><strong>${escapeHtml(name)}</strong> wants to access your yt-digest account.</p>
<p>Redirect URI: <code>${escapeHtml(redirectUri)}</code></p>
<p>Scope: <code>${escapeHtml(scope)}</code></p>
<form method="post" action="/authorize/consent">
<input type="hidden" name="request" value="${escapeHtml(requestId)}">
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form>`,
  );
}

interface PendingRow {
  client_id: string;
  redirect_uri: string;
  client_state: string | null;
}

export async function googleEndpoint(env: Env, key: "authorization_endpoint" | "token_endpoint" | "jwks_uri"): Promise<string> {
  const response = await fetch(`${(env.GOOGLE_ISSUER ?? "").replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`discovery failed: ${response.status}`);
  const value = ((await response.json()) as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`discovery has no ${key}`);
  return value;
}

export async function consent(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage(400, "The form could not be read.");
  }
  const requestId = form.get("request");
  const decision = form.get("decision");
  if (typeof requestId !== "string") return errorPage(400, "This authorization request is unknown, expired or already used.");
  if (decision !== "approve" && decision !== "deny") return errorPage(400, "Unknown decision.");
  const now = new Date().toISOString();
  if (decision === "deny") {
    const row = await env.DB.prepare(
      "UPDATE oauth_requests SET used_at = ?2 WHERE request_id = ?1 AND used_at IS NULL AND expires_at > ?2 RETURNING client_id, redirect_uri, client_state",
    )
      .bind(requestId, now)
      .first<PendingRow>();
    if (row === null) return errorPage(400, "This authorization request is unknown, expired or already used.");
    log("auth.oauth.denied", { attrs: { client_id: row.client_id, reason: "access_denied" } });
    return redirectTo(row.redirect_uri, { error: "access_denied" }, row.client_state);
  }
  let authorizationEndpoint: string;
  try {
    authorizationEndpoint = await googleEndpoint(env, "authorization_endpoint");
  } catch {
    return errorPage(502, "The identity provider is unavailable.");
  }
  const googleState = randomToken(24);
  const nonce = randomToken(24);
  const updated = await env.DB.prepare(
    "UPDATE oauth_requests SET google_state = ?2, google_nonce = ?3 WHERE request_id = ?1 AND used_at IS NULL AND google_state IS NULL AND expires_at > ?4",
  )
    .bind(requestId, googleState, nonce, now)
    .run();
  if (updated.meta.changes === 0) return errorPage(400, "This authorization request is unknown, expired or already used.");
  const url = new URL(authorizationEndpoint);
  const params: Record<string, string> = {
    client_id: env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: `${baseUrl(env)}/callback`,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    state: googleState,
    nonce,
    access_type: "offline",
    prompt: "consent",
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return new Response(null, { status: 302, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}
