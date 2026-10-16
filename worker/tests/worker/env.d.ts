declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TRANSCRIPTS: R2Bucket;
    TEST_MIGRATIONS: import("@cloudflare/vitest-plugin").D1Migration[];
  }
}
