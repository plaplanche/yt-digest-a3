import { env } from "cloudflare:workers";
import { expect, test } from "vitest";

const TABLES: Record<string, string[]> = {
  nodes: ["node_id", "owner_label", "token_hash", "state", "state_since", "last_heartbeat_at", "version", "hourly_budget", "created_at", "revoked_at"],
  jobs: ["video_id", "kind", "priority", "status", "leased_by", "lease_id", "lease_expires_at", "attempts", "tried_nodes", "last_outcome", "created_at", "done_at"],
  leases: ["lease_id", "video_id", "node_id", "issued_at", "expires_at", "state", "response_json"],
  node_events: ["node_id", "ts", "kind", "video_id"],
  invites: ["email", "invited_at", "accepted_user_sub", "revoked"],
  users: ["user_sub", "email", "role", "google_refresh_token_enc", "created_at"],
  oauth_clients: ["client_id", "client_name", "redirect_uris", "created_at"],
  oauth_requests: ["request_id", "client_id", "redirect_uri", "client_state", "code_challenge", "scope", "resource", "google_state", "google_nonce", "expires_at", "used_at"],
  oauth_codes: ["code_hash", "client_id", "user_sub", "redirect_uri", "code_challenge", "scope", "resource", "expires_at", "used_at"],
  oauth_tokens: ["token_hash", "kind", "client_id", "user_sub", "family_id", "scope", "resource", "expires_at", "used_at", "revoked_at"],
};

test.each(Object.entries(TABLES))("table %s has every column of 6.3", async (table, columns) => {
  const { results } = await env.DB.prepare("SELECT name FROM pragma_table_info(?)").bind(table).all<{ name: string }>();
  expect(results.map((row) => row.name)).toEqual(expect.arrayContaining(columns));
});

test("defaults of nodes and jobs", async () => {
  await env.DB.prepare("INSERT INTO nodes (node_id, owner_label, token_hash, state_since, created_at) VALUES ('n', 'o', 'h', 't', 't')").run();
  await env.DB.prepare("INSERT INTO jobs (video_id, created_at) VALUES ('aaaaaaaaaaa', 't')").run();
  expect(await env.DB.prepare("SELECT state, hourly_budget FROM nodes").first()).toEqual({ state: "healthy", hourly_budget: 60 });
  expect(await env.DB.prepare("SELECT kind, status, priority, attempts, tried_nodes FROM jobs").first()).toEqual({
    kind: "primary",
    status: "queued",
    priority: 0,
    attempts: 0,
    tried_nodes: "[]",
  });
  await env.DB.batch([env.DB.prepare("DELETE FROM nodes"), env.DB.prepare("DELETE FROM jobs")]);
});
