import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp, TEST_PASSWORD } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

// Regression for the home-hosting INVALID_ORIGIN bug: Better Auth only checks
// the Origin header when cookies ride along, so every case below signs up
// first (cookie present) and then re-authenticates from the probed origin.
describe("CSRF origin policy", () => {
  const attempt = async (origin: string) => {
    const client = new TestClient(BASE, origin);
    await signUp(client, "Elia");
    return client.post("/agent/auth/sign-in/username", {
      username: "elia",
      password: TEST_PASSWORD,
    });
  };

  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://192.168.1.50:5173",
    "http://10.0.0.7:8080",
    "http://homeserver.local:5173",
    "http://myserver.tailnet-foo.ts.net",
    "http://100.101.102.103:5173",
  ])("trusts the private-network origin %s", async (origin) => {
    expect((await attempt(origin)).status).toBe(200);
  });

  it.each([
    "https://evil.example.com",
    "http://172.40.1.1:5173", // outside the 172.16–31 private block
    "http://8.8.8.8:5173",
  ])("rejects the public origin %s", async (origin) => {
    const client = new TestClient(BASE); // sign up from a trusted origin…
    await signUp(client, "Elia");
    // …then replay a cookie-carrying auth call from the hostile origin.
    const { status, body } = await client.post(
      "/agent/auth/sign-in/username",
      { username: "elia", password: TEST_PASSWORD },
      { origin }
    );
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.code).toBe("INVALID_ORIGIN");
  });
});
