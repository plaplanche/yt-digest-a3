import pkg from "../package.json";
import type { Env } from "./env";
import { json, notFound } from "./http";
import { callback } from "./callback";
import { handleMcp } from "./mcp";
import { handleNode } from "./nodes";
import { authorize, consent, discovery, register } from "./oauth";
import { handleOps } from "./ops";
import { token } from "./token";

const DISCOVERY_PATHS = [
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ops" || path.startsWith("/ops/")) {
      return handleOps(request, env, path);
    }
    if (path.startsWith("/node/")) {
      return handleNode(request, env, path);
    }
    if (request.method === "GET" && path === "/health") {
      return json({ status: "ok", version: pkg.version });
    }
    const method = request.method;
    if (method === "GET" && DISCOVERY_PATHS.includes(path)) return discovery(env, path);
    if (method === "POST" && path === "/register") return register(request, env);
    if (method === "GET" && path === "/authorize") return authorize(request, env);
    if (method === "POST" && path === "/authorize/consent") return consent(request, env);
    if (method === "POST" && path === "/token") return token(request, env);
    if (method === "POST" && path === "/mcp") return handleMcp(request, env);
    if (method === "GET" && path === "/callback") return callback(request, env);
    return notFound();
  },
};
