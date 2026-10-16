import { expect, test } from "vitest";
import { name } from "../src/index";

test("package exports its name", () => {
  expect(name).toBe("yt-digest-worker");
});
