import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

const port = Number(process.env.MOCKS_PORT ?? "8789");
const clientId = process.env.GOOGLE_CLIENT_ID ?? "yt-digest-local";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "local-google-secret";
const issuer = `http://127.0.0.1:${port}/google`;

const CODE_TTL_MS = 60_000;
const TOKEN_TTL_SECONDS = 3600;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomBytes(8).toString("hex");
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };

interface Grant {
  email: string;
  scope: string;
}

interface AuthCode extends Grant {
  redirectUri: string;
  nonce: string | null;
  offline: boolean;
  expiresAt: number;
}

const codes = new Map<string, AuthCode>();
const accessTokens = new Map<string, Grant & { expiresAt: number }>();
const refreshTokens = new Map<string, Grant>();

function send(res: ServerResponse, status: number, body: string, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": contentType, ...headers });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void =>
  send(res, status, JSON.stringify(body), "application/json", { "Cache-Control": "no-store" });

const base64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");
const subject = (email: string): string => `g-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
const newSecret = (): string => randomBytes(24).toString("base64url");
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function idToken(email: string, nonce: string | null): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: clientId,
    sub: subject(email),
    email,
    email_verified: true,
    iat,
    exp: iat + TOKEN_TTL_SECONDS,
    ...(nonce === null ? {} : { nonce }),
  };
  const signingInput = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }))}.${base64url(JSON.stringify(claims))}`;
  return `${signingInput}.${base64url(sign("sha256", Buffer.from(signingInput), privateKey))}`;
}

function discovery(): unknown {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

function authorize(res: ServerResponse, params: URLSearchParams): void {
  const scope = params.get("scope") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (
    params.get("client_id") !== clientId ||
    redirectUri === "" ||
    params.get("response_type") !== "code" ||
    !scope.split(/\s+/).includes("openid")
  ) {
    send(res, 400, "Bad Request", "text/plain");
    return;
  }
  const hint = params.get("login_hint") ?? "";
  if (hint === "") {
    const hidden = [...params.entries()]
      .filter(([name]) => name !== "login_hint")
      .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
      .join("\n    ");
    send(
      res,
      200,
      `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in</title></head>
<body>
  <h1>Sign in with Google (mock)</h1>
  <form method="get" action="/google/authorize">
    ${hidden}
    <label>E-mail <input type="text" name="login_hint"></label>
    <button type="submit">Sign in</button>
  </form>
</body>
</html>
`,
      "text/html; charset=utf-8",
    );
    return;
  }
  const code = newSecret();
  codes.set(code, {
    email: hint.toLowerCase(),
    scope,
    redirectUri,
    nonce: params.get("nonce"),
    offline: params.get("access_type") === "offline",
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  let location: URL;
  try {
    location = new URL(redirectUri);
  } catch {
    send(res, 400, "Bad Request", "text/plain");
    return;
  }
  location.searchParams.set("code", code);
  const state = params.get("state");
  if (state !== null) location.searchParams.set("state", state);
  send(res, 302, "", "text/plain", { Location: location.toString() });
}

function clientAuthenticated(req: IncomingMessage, form: URLSearchParams): boolean {
  const header = req.headers.authorization;
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  if (header?.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    id = colon < 0 ? decoded : decoded.slice(0, colon);
    secret = colon < 0 ? "" : decoded.slice(colon + 1);
  }
  return id === clientId && secret === clientSecret;
}

function issueAccessToken(grant: Grant): string {
  const token = newSecret();
  accessTokens.set(token, { ...grant, expiresAt: Date.now() + TOKEN_TTL_SECONDS * 1000 });
  return token;
}

function token(req: IncomingMessage, res: ServerResponse, form: URLSearchParams): void {
  if (!clientAuthenticated(req, form)) {
    sendJson(res, 401, { error: "invalid_client" });
    return;
  }
  const grantType = form.get("grant_type");
  const invalidGrant = (): void => sendJson(res, 400, { error: "invalid_grant" });
  if (grantType === "authorization_code") {
    const code = codes.get(form.get("code") ?? "");
    if (code === undefined) return invalidGrant();
    codes.delete(form.get("code") ?? "");
    if (code.expiresAt < Date.now() || code.redirectUri !== form.get("redirect_uri")) return invalidGrant();
    const body: Record<string, unknown> = {
      access_token: issueAccessToken(code),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: code.scope,
      id_token: idToken(code.email, code.nonce),
    };
    if (code.offline) {
      const refresh = newSecret();
      refreshTokens.set(refresh, { email: code.email, scope: code.scope });
      body.refresh_token = refresh;
    }
    sendJson(res, 200, body);
  } else if (grantType === "refresh_token") {
    const grant = refreshTokens.get(form.get("refresh_token") ?? "");
    if (grant === undefined) return invalidGrant();
    sendJson(res, 200, {
      access_token: issueAccessToken(grant),
      token_type: "Bearer",
      expires_in: TOKEN_TTL_SECONDS,
      scope: grant.scope,
      id_token: idToken(grant.email, null),
    });
  } else {
    invalidGrant();
  }
}

function userinfo(req: IncomingMessage, res: ServerResponse): void {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  const grant = match?.[1] === undefined ? undefined : accessTokens.get(match[1]);
  if (grant === undefined || grant.expiresAt < Date.now()) {
    send(res, 401, "Unauthorized", "text/plain", { "WWW-Authenticate": "Bearer" });
    return;
  }
  sendJson(res, 200, { sub: subject(grant.email), email: grant.email, email_verified: true });
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    console.log(`${req.method} ${url.pathname}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === "GET /health") {
      sendJson(res, 200, { status: "ok" });
    } else if (route === "GET /google/.well-known/openid-configuration") {
      sendJson(res, 200, discovery());
    } else if (route === "GET /google/authorize") {
      authorize(res, url.searchParams);
    } else if (route === "POST /google/token") {
      token(req, res, await readForm(req));
    } else if (route === "GET /google/userinfo") {
      userinfo(req, res);
    } else if (route === "GET /google/jwks") {
      sendJson(res, 200, { keys: [jwk] });
    } else if (route === "POST /google/revoke") {
      await readForm(req);
      send(res, 200, "", "text/plain");
    } else {
      send(res, 404, "Not Found", "text/plain");
    }
  })().catch((error: unknown) => {
    console.error(error);
    if (!res.headersSent) send(res, 500, "Internal Server Error", "text/plain");
  });
});

server.listen(port, "127.0.0.1", () => console.log(`mocks: listening on 127.0.0.1:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
