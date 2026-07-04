import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

describe("database backup download", () => {
  it("requires authentication", async () => {
    const anon = new TestClient(BASE);
    const res = await anon.get("/agent/backup");
    expect(res.status).toBe(401);
  });

  it("streams a pg_dump custom-format archive to an authenticated user", async (ctx) => {
    const user = new TestClient(BASE);
    await signUp(user, "User");

    const res = await user.request("/agent/backup");

    // The endpoint shells out to the host's pg_dump; dev machines without a
    // client matching the server's major version legitimately can't dump
    // (e.g. Homebrew pg_dump 17 vs the pg18 container). Skip, don't fail.
    if (res.status === 500) {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string" && body.error.includes("pg_dump")) {
        console.warn(`Skipping backup download test: ${body.error}`);
        ctx.skip();
      }
      expect.fail(`Unexpected 500: ${JSON.stringify(body)}`);
    }

    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="agent-backup-\d{4}-\d{2}-\d{2}\.dump"$/
    );

    // Custom-format archives start with the "PGDMP" magic bytes.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(5);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("PGDMP");
  });
});
