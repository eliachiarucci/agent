import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serverUrl } from "../config";
import { TestClient } from "../helpers/client";
import { signUp } from "../helpers/auth";
import { closeDb, resetDb } from "../helpers/db";

const BASE = serverUrl("api");

beforeEach(resetDb);
afterAll(closeDb);

const CREDS = { clientId: "client-id.apps.googleusercontent.com", clientSecret: "shh-secret" };

describe("connectors API", () => {
  it("requires authentication everywhere", async () => {
    const client = new TestClient(BASE);
    expect((await client.get("/agent/connectors")).status).toBe(401);
    expect((await client.post("/agent/connectors/gmail", CREDS)).status).toBe(401);
    expect((await client.delete("/agent/connectors/gmail")).status).toBe(401);
    const authorize = await client.request("/agent/connectors/gmail/authorize", {
      redirect: "manual",
    });
    expect(authorize.status).toBe(401);
    expect(
      (
        await client.get(
          "/agent/tool-permissions?agent_id=00000000-0000-4000-8000-000000000000"
        )
      ).status
    ).toBe(401);
  });

  it("lists the catalog with an unconfigured gmail entry", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");

    const { status, body } = await client.get("/agent/connectors");
    expect(status).toBe(200);
    const gmail = body.find((c: any) => c.connector === "gmail");
    expect(gmail).toMatchObject({
      name: "Gmail",
      status: "disconnected",
      clientId: null,
      hasClientSecret: false,
      email: null,
    });
    expect(gmail.redirectUri).toContain("/agent/connectors/gmail/callback");
    expect(gmail.tools.length).toBeGreaterThan(0);
    expect(gmail.tools[0]).toHaveProperty("name");
    expect(gmail.tools[0]).toHaveProperty("kind");
  });

  it("stores credentials masked, and keeps the secret on secretless updates", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");

    const saved = await client.post("/agent/connectors/gmail", CREDS);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({
      connector: "gmail",
      clientId: CREDS.clientId,
      hasClientSecret: true,
      status: "disconnected",
    });
    expect(JSON.stringify(saved.body)).not.toContain(CREDS.clientSecret);

    // Same clientId, no secret → stored secret is reused.
    const updated = await client.post("/agent/connectors/gmail", { clientId: CREDS.clientId });
    expect(updated.status).toBe(200);
    expect(updated.body.hasClientSecret).toBe(true);

    // No stored secret at all → 400.
    const other = new TestClient(BASE);
    await signUp(other, "Sam");
    expect((await other.post("/agent/connectors/gmail", { clientId: "x" })).status).toBe(400);
  });

  it("credentials are per user", async () => {
    const pat = new TestClient(BASE);
    await signUp(pat, "Pat");
    await pat.post("/agent/connectors/gmail", CREDS);

    const sam = new TestClient(BASE);
    await signUp(sam, "Sam");
    const { body } = await sam.get("/agent/connectors");
    expect(body.find((c: any) => c.connector === "gmail").clientId).toBeNull();
  });

  it("authorize requires stored credentials, then redirects to Google with a signed state", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");

    const missing = await client.request("/agent/connectors/gmail/authorize", {
      redirect: "manual",
    });
    expect(missing.status).toBe(400);

    await client.post("/agent/connectors/gmail", CREDS);
    const res = await client.request("/agent/connectors/gmail/authorize", {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe(CREDS.clientId);
    expect(location.searchParams.get("access_type")).toBe("offline");
    expect(location.searchParams.get("prompt")).toBe("consent");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toContain("gmail.readonly");
    expect(location.searchParams.get("scope")).not.toContain("gmail.send");
    expect(location.searchParams.get("redirect_uri")).toContain(
      "/agent/connectors/gmail/callback"
    );
    // Signed, two-part state.
    expect(location.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("callback rejects forged or missing states with an error redirect", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    await client.post("/agent/connectors/gmail", CREDS);

    const forged = await client.request(
      "/agent/connectors/gmail/callback?code=abc&state=bogus.bogus",
      { redirect: "manual" }
    );
    expect(forged.status).toBe(302);
    const location = new URL(forged.headers.get("location")!);
    expect(location.searchParams.get("connector_status")).toBe("error");

    const missing = await client.request("/agent/connectors/gmail/callback", {
      redirect: "manual",
    });
    expect(new URL(missing.headers.get("location")!).searchParams.get("connector_status")).toBe(
      "error"
    );

    // Google-reported errors (user clicked cancel) land as an error redirect too.
    const denied = await client.request(
      "/agent/connectors/gmail/callback?error=access_denied",
      { redirect: "manual" }
    );
    expect(new URL(denied.headers.get("location")!).searchParams.get("connector_error")).toBe(
      "Access was denied"
    );
  });

  it("delete removes the configuration", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    expect((await client.delete("/agent/connectors/gmail")).status).toBe(404);

    await client.post("/agent/connectors/gmail", CREDS);
    expect((await client.delete("/agent/connectors/gmail")).status).toBe(204);
    const { body } = await client.get("/agent/connectors");
    expect(body.find((c: any) => c.connector === "gmail").hasClientSecret).toBe(false);
  });
});

describe("tool permissions API", () => {
  // Sign-up auto-creates a "Personal Assistant" agent; permissions are scoped to it.
  async function defaultAgentId(client: TestClient): Promise<string> {
    const { body } = await client.get("/agent/agents");
    return body[0].id;
  }

  it("defaults to {} and round-trips per agent", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    const agentId = await defaultAgentId(client);

    const empty = await client.get(`/agent/tool-permissions?agent_id=${agentId}`);
    expect(empty.status).toBe(200);
    expect(empty.body.permissions).toEqual({});

    const saved = await client.post("/agent/tool-permissions", {
      agent_id: agentId,
      permissions: { gmail: { create_draft: "deny", get_thread: "ask", search_threads: "allow" } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.permissions).toEqual({
      gmail: { create_draft: "deny", get_thread: "ask", search_threads: "allow" },
    });

    const fetched = await client.get(`/agent/tool-permissions?agent_id=${agentId}`);
    expect(fetched.body.permissions).toEqual({
      gmail: { create_draft: "deny", get_thread: "ask", search_threads: "allow" },
    });
  });

  it("validates input", async () => {
    const client = new TestClient(BASE);
    await signUp(client, "Pat");
    const agentId = await defaultAgentId(client);
    expect((await client.get("/agent/tool-permissions")).status).toBe(400);
    expect(
      (
        await client.post("/agent/tool-permissions", {
          agent_id: "not-a-uuid",
          permissions: {},
        })
      ).status
    ).toBe(400);
    // Only deny/ask/allow are accepted levels.
    expect(
      (
        await client.post("/agent/tool-permissions", {
          agent_id: agentId,
          permissions: { gmail: { tool: "yes" } },
        })
      ).status
    ).toBe(400);
  });

  it("is scoped to agent members", async () => {
    const pat = new TestClient(BASE);
    await signUp(pat, "Pat");
    const patAgent = await defaultAgentId(pat);
    await pat.post("/agent/tool-permissions", {
      agent_id: patAgent,
      permissions: { gmail: { get_thread: "deny" } },
    });

    // Sam is not a member of Pat's agent: no reads, no writes.
    const sam = new TestClient(BASE);
    await signUp(sam, "Sam");
    expect((await sam.get(`/agent/tool-permissions?agent_id=${patAgent}`)).status).toBe(403);
    expect(
      (
        await sam.post("/agent/tool-permissions", {
          agent_id: patAgent,
          permissions: { gmail: { get_thread: "allow" } },
        })
      ).status
    ).toBe(403);

    // Sam's own agent is untouched by Pat's settings.
    const samAgent = await defaultAgentId(sam);
    const { body } = await sam.get(`/agent/tool-permissions?agent_id=${samAgent}`);
    expect(body.permissions).toEqual({});
  });
});
