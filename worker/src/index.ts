import pkg from "../package.json";
import type { Env } from "./env";
import { json, notFound } from "./http";
import { handleOps } from "./ops";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/ops" || path.startsWith("/ops/")) {
      return handleOps(request, env, path);
    }
    if (request.method === "GET" && path === "/health") {
      return json({ status: "ok", version: pkg.version });
    }
    return notFound();
  },
};
