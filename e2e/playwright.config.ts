import { defineConfig } from "@playwright/test";

const workerUrl = `http://127.0.0.1:${process.env.WORKER_PORT ?? "8787"}`;

export default defineConfig({
  testDir: "tests",
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: workerUrl },
  projects: [
    { name: "api", testMatch: "**/*.api.spec.ts" },
    { name: "browser", testMatch: "**/*.browser.spec.ts", use: { browserName: "chromium" } },
  ],
});
