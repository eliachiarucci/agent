import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

describe("user settings (default model)", () => {
  it("defaults to null, then sets, reads back, and clears the default model", async () => {
    const user = new TestClient(BASE);
    await signUp(user, "User");

    const initial = await user.get("/agent/settings");
    expect(initial.body).toEqual({ defaultProvider: null, defaultModel: null });

    const set = await user.patch("/agent/settings", {
      default_provider: "anthropic",
      default_model: "claude-opus-4-8",
    });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ defaultProvider: "anthropic", defaultModel: "claude-opus-4-8" });

    expect((await user.get("/agent/settings")).body).toEqual({
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-8",
    });

    const cleared = await user.patch("/agent/settings", {
      default_provider: null,
      default_model: null,
    });
    expect(cleared.body).toEqual({ defaultProvider: null, defaultModel: null });
  });

  it("rejects an unknown provider and empty patches", async () => {
    const user = new TestClient(BASE);
    await signUp(user, "User");

    expect((await user.patch("/agent/settings", { default_provider: "nope" })).status).toBe(400);
    expect((await user.patch("/agent/settings", {})).status).toBe(400);
  });

  it("requires authentication", async () => {
    const anon = new TestClient(BASE);
    expect((await anon.get("/agent/settings")).status).toBe(401);
  });
});
