import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enqueue, enroll, getJob, opsHeaders, reset } from "./nodes";
import { mocksUrl, workerUrl } from "./stack";

const repoRoot = path.resolve(process.cwd(), "..");
const videoId = "e2eNode0001";

test.beforeEach(async ({ request }) => {
  await reset(request);
});

test("yt-digest-node work --once processes a queued fixture video", async ({ request }) => {
  const fixtures = mkdtempSync(path.join(tmpdir(), "yt-digest-fixtures-"));
  try {
    mkdirSync(path.join(fixtures, videoId));
    writeFileSync(path.join(fixtures, videoId, "meta.json"), '{"duration": 60}');
    writeFileSync(path.join(fixtures, videoId, "en.manual.vtt"), "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello brave new world\n");

    const token = await enroll(request, "node-daemon");
    await enqueue(request, [videoId]);

    const run = spawnSync("uv", ["run", "--project", "node", "yt-digest-node", "work", "--once"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        WORKER_URL: workerUrl,
        NODE_TOKEN: token,
        FETCHER_FAKE_YTDLP: "1",
        FAKE_YTDLP_DIR: fixtures,
        SPONSORBLOCK_URL: `${mocksUrl}/sponsorblock`,
      },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).not.toContain(token);

    expect(await getJob(request, videoId)).toMatchObject({ status: "done", last_outcome: "ok", leased_by: "node-daemon" });
    const response = await request.get(`${workerUrl}/ops/transcripts/${videoId}`, { headers: opsHeaders });
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      video_id: videoId,
      node_id: "node-daemon",
      transcript: { video_id: videoId, status: "ok", lang: "en", source: "manual", word_count: 4, pages: ["hello brave new world"] },
    });
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
});
