import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(new URL("./migrations", import.meta.url).pathname);

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "node", include: ["tests/*.test.ts"] },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./wrangler.toml" },
            miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
          }),
        ],
        test: { name: "worker", include: ["tests/worker/**/*.test.ts"], setupFiles: ["./tests/worker/setup.ts"] },
      },
    ],
  },
});
