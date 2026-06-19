import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

// Stand-in for LM Studio: an OpenAI-compatible /v1/models endpoint the backend
// can reach over localhost. `requireKey` simulates LM Studio with auth enabled.
function fakeLmStudio(options: { requireKey?: string } = {}) {
  const server = createServer((req, res) => {
    if (req.url !== "/v1/models") {
      res.writeHead(404).end();
      return;
    }
    if (options.requireKey && req.headers.authorization !== `Bearer ${options.requireKey}`) {
      res.writeHead(401).end();
      return;
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ data: [{ id: "test-model-a" }, { id: "test-model-b" }] }));
  });
  return new Promise<{ url: string; server: Server }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}

describe("provider settings", () => {
  let mock: { url: string; server: Server } | undefined;

  afterEach(() => {
    mock?.server.close();
    mock = undefined;
  });

  it("requires authentication on every method", async () => {
    const anon = new TestClient(BASE);
    expect((await anon.get("/agent/providers")).status).toBe(401);
    expect(
      (await anon.post("/agent/providers", { provider: "lmstudio", settings: { url: "http://x" } }))
        .status
    ).toBe(401);
    expect(
      (await anon.post("/agent/provider-test", { provider: "lmstudio", settings: { url: "http://x" } }))
        .status
    ).toBe(401);
    expect((await anon.delete("/agent/providers?provider=lmstudio")).status).toBe(401);
  });

  it("rejects unknown providers and malformed settings", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");

    const unknown = await client.post("/agent/providers", {
      provider: "not-a-real-provider",
      settings: { apiKey: "x" },
    });
    expect(unknown.status).toBe(400);

    const badUrl = await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: "not-a-url" },
    });
    expect(badUrl.status).toBe(400);

    // Anthropic requires an API key.
    const noKey = await client.post("/agent/providers", {
      provider: "anthropic",
      settings: {},
    });
    expect(noKey.status).toBe(400);

    // So do Google and DeepInfra.
    const noGoogleKey = await client.post("/agent/providers", {
      provider: "google",
      settings: {},
    });
    expect(noGoogleKey.status).toBe(400);

    const noDeepInfraKey = await client.post("/agent/providers", {
      provider: "deepinfra",
      settings: {},
    });
    expect(noDeepInfraKey.status).toBe(400);
  });

  it("tests the connection and saves only on success", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    mock = await fakeLmStudio();

    // Unreachable server → 422, nothing saved.
    const failed = await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: "http://127.0.0.1:9" },
    });
    expect(failed.status).toBe(422);
    expect(typeof failed.body.error).toBe("string");
    expect((await client.get("/agent/providers")).body).toHaveLength(0);

    // Reachable server → saved, models returned.
    const saved = await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url, model: "test-model-a" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.models).toEqual(["test-model-a", "test-model-b"]);
    expect(saved.body.provider.provider).toBe("lmstudio");

    const list = (await client.get("/agent/providers")).body;
    expect(list).toHaveLength(1);
    expect(list[0].settings).toEqual({
      url: mock.url,
      model: "test-model-a",
      hasApiKey: false,
    });
  });

  it("never returns stored API keys and keeps them across key-less updates", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    mock = await fakeLmStudio({ requireKey: "secret-key" });

    // Wrong key → 422 from the provider test.
    const wrongKey = await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url, apiKey: "wrong" },
    });
    expect(wrongKey.status).toBe(422);

    const saved = await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url, apiKey: "secret-key" },
    });
    expect(saved.status).toBe(200);

    // The key is masked everywhere it could surface.
    expect(JSON.stringify(saved.body)).not.toContain("secret-key");
    const list = (await client.get("/agent/providers")).body;
    expect(JSON.stringify(list)).not.toContain("secret-key");
    expect(list[0].settings.hasApiKey).toBe(true);

    // Updating without re-sending the key reuses the stored one (the mock still
    // requires it, so the test call only passes if the key was carried over).
    const update = await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url, model: "test-model-b" },
    });
    expect(update.status).toBe(200);
    expect((await client.get("/agent/providers")).body[0].settings.model).toBe("test-model-b");
  });

  it("provider-test verifies without saving", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    mock = await fakeLmStudio();

    const test = await client.post("/agent/provider-test", {
      provider: "lmstudio",
      settings: { url: mock.url },
    });
    expect(test.status).toBe(200);
    expect(test.body.models).toEqual(["test-model-a", "test-model-b"]);
    expect((await client.get("/agent/providers")).body).toHaveLength(0);
  });

  it("rejects Anthropic setup tokens with a pointed error, offline", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");

    const res = await client.post("/agent/provider-test", {
      provider: "anthropic",
      settings: { apiKey: "sk-ant-oat01-abc" },
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/setup token/i);
  });

  it("rejects chat requests bound to an unconfigured provider or missing model", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    mock = await fakeLmStudio();

    const unconfigured = await client.post("/agent/conversation", {
      message: "hi",
      provider: "anthropic",
      model: "claude-opus-4-8",
    });
    expect(unconfigured.status).toBe(400);
    expect(unconfigured.body.error).toMatch(/not configured/i);

    // Configured but neither a request model nor a stored default → 400.
    await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url },
    });
    const noModel = await client.post("/agent/conversation", {
      message: "hi",
      provider: "lmstudio",
    });
    expect(noModel.status).toBe(400);
    expect(noModel.body.error).toMatch(/no model selected/i);
  });

  it("reports the context window of a configured provider", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");

    // Provider-scoped lookups need a session.
    const anon = new TestClient(BASE);
    expect((await anon.get("/agent/context?provider=lmstudio")).status).toBe(401);

    expect((await client.get("/agent/context?provider=lmstudio")).status).toBe(404);

    mock = await fakeLmStudio();
    await client.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url, model: "test-model-a" },
    });
    // The mock has no /api/v0 endpoint, so the window is unknown — but the
    // route resolves the stored model and answers.
    const ctx = await client.get("/agent/context?provider=lmstudio");
    expect(ctx.status).toBe(200);
    expect(ctx.body).toEqual({ model: "test-model-a", contextLength: null });
  });

  it("scopes settings per user and supports deletion", async () => {
    const alice = new TestClient(BASE);
    const bob = new TestClient(BASE);
    await signUp(alice, "Alice");
    await signUp(bob, "Bob");
    mock = await fakeLmStudio();

    await alice.post("/agent/providers", {
      provider: "lmstudio",
      settings: { url: mock.url },
    });

    expect((await bob.get("/agent/providers")).body).toHaveLength(0);
    expect((await bob.delete("/agent/providers?provider=lmstudio")).status).toBe(404);

    expect((await alice.delete("/agent/providers?provider=lmstudio")).status).toBe(204);
    expect((await alice.get("/agent/providers")).body).toHaveLength(0);
  });
});
