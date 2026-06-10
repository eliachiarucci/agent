import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signIn, signUp, TEST_PASSWORD } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

describe("signup", () => {
  it("creates the account, a session, and the default agent", async () => {
    const client = new TestClient(BASE);
    const user = await signUp(client, "Elia");
    expect(user.id).toMatch(/^[0-9a-f-]{36}$/);

    const { status, body } = await client.get("/agent/agents");
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: "Personal Assistant", role: "owner", ownerId: user.id });
  });

  it("rejects duplicate usernames", async () => {
    await signUp(new TestClient(BASE), "Elia");
    const { status } = await new TestClient(BASE).post("/agent/auth/sign-up/email", {
      name: "Other",
      username: "elia",
      email: "other@test.local",
      password: TEST_PASSWORD,
    });
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe("sign in", () => {
  it("is case-insensitive on the username", async () => {
    await signUp(new TestClient(BASE), "Elia");
    const client = new TestClient(BASE);
    expect((await signIn(client, "ELIA")).status).toBe(200);
    expect((await client.get("/agent/agents")).status).toBe(200);
  });

  it("rejects a wrong password", async () => {
    await signUp(new TestClient(BASE), "Elia");
    const { status, body } = await signIn(new TestClient(BASE), "elia", "not-the-password");
    expect(status).toBe(401);
    expect(body.code).toBe("INVALID_USERNAME_OR_PASSWORD");
  });

  it("sign-out invalidates the session", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Elia");
    expect((await client.get("/agent/agents")).status).toBe(200);

    expect((await client.post("/agent/auth/sign-out")).status).toBe(200);
    expect((await client.get("/agent/agents")).status).toBe(401);
  });
});

describe("unauthenticated access", () => {
  it.each([
    ["GET", "/agent/agents"],
    ["GET", "/agent/users"],
    ["GET", "/agent/members"],
    ["GET", "/agent/memory"],
    ["GET", "/agent/conversation"],
    ["POST", "/agent/conversation"],
  ])("%s %s returns 401", async (method, path) => {
    const client = new TestClient(BASE);
    const { status } =
      method === "GET" ? await client.get(path) : await client.post(path, { message: "hi" });
    expect(status).toBe(401);
  });
});
