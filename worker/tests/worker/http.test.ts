import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import errorSchema from "../../../contracts/error.schema.json";
import pkg from "../../package.json";
import { call } from "./helpers";

const validError = new Ajv2020({ strict: false }).compile(errorSchema);

describe("GET /health", () => {
  test("is public and answers the version of worker/package.json", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ status: "ok", version: pkg.version });
  });
});

describe("unknown routes", () => {
  test.each([
    ["GET", "/nope"],
    ["POST", "/health"],
    ["GET", "/"],
    ["GET", "/node/claim"],
  ])("%s %s gives 404 not_found with the error body", async (method, path) => {
    const response = await call(path, { method });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    const body: unknown = await response.json();
    expect(validError(body)).toBe(true);
    expect(body).toMatchObject({ error: { code: "not_found" } });
  });
});
