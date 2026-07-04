import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectorAuthError,
  getConnectorAccessToken,
  signState,
  verifyState,
} from "../../lib/agent/connectors/google-auth";
import {
  buildGmailTools,
  buildRawEmail,
  extractMessageBody,
  gmailToolInfo,
} from "../../lib/agent/connectors/gmail";
import { buildConnectorTools } from "../../lib/agent/connectors";
import {
  getConnectorSetting,
  setConnectorTokens,
  upsertConnectorSetting,
} from "../../lib/db/connectors";
import { getToolPermissions, upsertToolPermissions } from "../../lib/db/tool-permissions";
import { closeDb, makeUser, resetDb } from "../helpers/db";
import type { ConnectorTokens } from "../../lib/global/schema";

beforeEach(resetDb);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
afterAll(closeDb);

const CREDS = { clientId: "client-id", clientSecret: "client-secret" };

function tokens(overrides: Partial<ConnectorTokens> = {}): ConnectorTokens {
  return {
    refreshToken: "refresh-1",
    accessToken: "access-1",
    accessTokenExpiresAt: Date.now() + 3600_000,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    email: "user@gmail.com",
    ...overrides,
  };
}

async function connectedUser(overrides: Partial<ConnectorTokens> = {}) {
  const user = await makeUser("Connie");
  await upsertConnectorSetting(user.id, "gmail", CREDS);
  await setConnectorTokens(user.id, "gmail", tokens(overrides), "connected");
  return user;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("oauth state", () => {
  it("round-trips and binds user + connector", () => {
    const state = signState("user-1", "gmail");
    expect(verifyState(state)).toMatchObject({ userId: "user-1", connector: "gmail" });
  });

  it("rejects tampered and malformed states", () => {
    const state = signState("user-1", "gmail");
    const [payload, sig] = state.split(".");
    // Forged payload with the original signature must not verify.
    const forged = Buffer.from(JSON.stringify({ userId: "attacker", connector: "gmail", exp: Date.now() + 60000 })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
    expect(verifyState(`${payload}.AAAA`)).toBeNull();
    expect(verifyState("garbage")).toBeNull();
    expect(verifyState("")).toBeNull();
  });

  it("rejects expired states", () => {
    vi.useFakeTimers();
    const state = signState("user-1", "gmail");
    vi.advanceTimersByTime(11 * 60_000);
    expect(verifyState(state)).toBeNull();
  });
});

describe("access token refresh", () => {
  it("returns the stored token while it is fresh, without calling Google", async () => {
    const user = await connectedUser();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getConnectorAccessToken(user.id, "gmail")).resolves.toBe("access-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the result", async () => {
    const user = await connectedUser({ accessTokenExpiresAt: Date.now() - 1000 });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: "access-2", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getConnectorAccessToken(user.id, "gmail")).resolves.toBe("access-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String(fetchMock.mock.calls[0][1].body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-1");

    const row = await getConnectorSetting(user.id, "gmail");
    expect(row?.tokens?.accessToken).toBe("access-2");
    // Google did not rotate the refresh token, so the old one is kept.
    expect(row?.tokens?.refreshToken).toBe("refresh-1");
    expect(row?.status).toBe("connected");
  });

  it("single-flights concurrent refreshes", async () => {
    const user = await connectedUser({ accessTokenExpiresAt: Date.now() - 1000 });
    const fetchMock = vi.fn(
      async () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(jsonResponse({ access_token: "access-2", expires_in: 3600 })), 20)
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      getConnectorAccessToken(user.id, "gmail"),
      getConnectorAccessToken(user.id, "gmail"),
    ]);
    expect(a).toBe("access-2");
    expect(b).toBe("access-2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks the connection broken on invalid_grant", async () => {
    const user = await connectedUser({ accessTokenExpiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "invalid_grant" }, 400))
    );

    await expect(getConnectorAccessToken(user.id, "gmail")).rejects.toBeInstanceOf(
      ConnectorAuthError
    );
    const row = await getConnectorSetting(user.id, "gmail");
    expect(row?.status).toBe("error");
  });

  it("throws ConnectorAuthError when never connected", async () => {
    const user = await makeUser("Nell");
    await expect(getConnectorAccessToken(user.id, "gmail")).rejects.toBeInstanceOf(
      ConnectorAuthError
    );
  });
});

describe("gmail message parsing", () => {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

  it("prefers text/plain in multipart messages", () => {
    const body = extractMessageBody({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("plain text") } },
        { mimeType: "text/html", body: { data: b64("<p>html text</p>") } },
      ],
    });
    expect(body).toBe("plain text");
  });

  it("converts html when no plain part exists, skipping images and links hrefs", () => {
    const body = extractMessageBody({
      mimeType: "multipart/alternative",
      parts: [
        {
          mimeType: "text/html",
          body: { data: b64('<p>hello <a href="http://x.test">there</a></p><img src="x.png">') },
        },
      ],
    });
    expect(body).toBe("hello there");
  });

  it("recurses nested multiparts and returns empty for attachment-only payloads", () => {
    const nested = extractMessageBody({
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64("nested") } }],
        },
        { mimeType: "application/pdf", body: {} },
      ],
    });
    expect(nested).toBe("nested");
    expect(extractMessageBody({ mimeType: "application/pdf", body: {} })).toBe("");
  });
});

describe("draft assembly", () => {
  it("builds an RFC 2822 message with base64 body", () => {
    const raw = buildRawEmail({
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      subject: "Hello",
      body: "Hi there",
      inReplyTo: "<msg-1@example.com>",
      references: "<msg-0@example.com> <msg-1@example.com>",
    });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("To: a@example.com, b@example.com");
    expect(mime).toContain("Cc: c@example.com");
    expect(mime).toContain("Subject: Hello");
    expect(mime).toContain("In-Reply-To: <msg-1@example.com>");
    expect(mime).toContain("References: <msg-0@example.com> <msg-1@example.com>");
    const body = mime.split("\r\n\r\n")[1];
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Hi there");
  });

  it("MIME-encodes non-ascii subjects", () => {
    const raw = buildRawEmail({ to: ["a@example.com"], subject: "Träume ✨", body: "x" });
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    expect(mime).toContain("Subject: =?UTF-8?B?");
    expect(mime).not.toContain("Träume");
  });
});

describe("tool permissions", () => {
  it("defaults to {} and round-trips saves per (provider, model)", async () => {
    const user = await makeUser("Perm");
    expect(await getToolPermissions(user.id, "anthropic", "claude-x")).toEqual({});

    await upsertToolPermissions(user.id, "anthropic", "claude-x", {
      gmail: { create_draft: false },
    });
    expect(await getToolPermissions(user.id, "anthropic", "claude-x")).toEqual({
      gmail: { create_draft: false },
    });
    // Other models are unaffected.
    expect(await getToolPermissions(user.id, "anthropic", "claude-y")).toEqual({});

    // Saving again replaces the map.
    await upsertToolPermissions(user.id, "anthropic", "claude-x", { gmail: {} });
    expect(await getToolPermissions(user.id, "anthropic", "claude-x")).toEqual({ gmail: {} });
  });

  it("filters gmail tools: missing keys mean enabled, false withholds", () => {
    const all = buildGmailTools("user-1");
    expect(Object.keys(all).sort()).toEqual(gmailToolInfo.map((t) => t.name).sort());

    const filtered = buildGmailTools("user-1", { create_draft: false, search_threads: true });
    expect(filtered.create_draft).toBeUndefined();
    expect(filtered.search_threads).toBeDefined();
    expect(Object.keys(filtered)).toHaveLength(gmailToolInfo.length - 1);
  });
});

describe("buildConnectorTools", () => {
  it("offers nothing when gmail is not connected or errored", async () => {
    const user = await makeUser("Uma");
    let result = await buildConnectorTools({ userId: user.id, provider: "anthropic", model: "m" });
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.prompt).toBe("");

    await upsertConnectorSetting(user.id, "gmail", CREDS);
    result = await buildConnectorTools({ userId: user.id, provider: "anthropic", model: "m" });
    expect(Object.keys(result.tools)).toHaveLength(0);

    await setConnectorTokens(user.id, "gmail", tokens(), "error");
    result = await buildConnectorTools({ userId: user.id, provider: "anthropic", model: "m" });
    expect(Object.keys(result.tools)).toHaveLength(0);
  });

  it("offers permission-filtered tools and the gmail prompt when connected", async () => {
    const user = await connectedUser();
    await upsertToolPermissions(user.id, "anthropic", "claude-x", {
      gmail: { label_thread: false, unlabel_thread: false },
    });

    const result = await buildConnectorTools({
      userId: user.id,
      provider: "anthropic",
      model: "claude-x",
    });
    expect(result.prompt).toContain("## Gmail");
    expect(result.tools.search_threads).toBeDefined();
    expect(result.tools.label_thread).toBeUndefined();
    expect(Object.keys(result.tools)).toHaveLength(gmailToolInfo.length - 2);

    // A different model has no toggles saved → full toolset.
    const other = await buildConnectorTools({
      userId: user.id,
      provider: "anthropic",
      model: "claude-y",
    });
    expect(Object.keys(other.tools)).toHaveLength(gmailToolInfo.length);
  });

  it("withholds the prompt when every tool is toggled off", async () => {
    const user = await connectedUser();
    await upsertToolPermissions(user.id, "anthropic", "claude-x", {
      gmail: Object.fromEntries(gmailToolInfo.map((t) => [t.name, false])),
    });
    const result = await buildConnectorTools({
      userId: user.id,
      provider: "anthropic",
      model: "claude-x",
    });
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.prompt).toBe("");
  });
});

describe("gmail tools against a stubbed API", () => {
  it("search_threads lists and summarizes threads", async () => {
    const user = await connectedUser();
    const fetchMock = vi.fn(async (url: any) => {
      const path = String(url);
      if (path.includes("/threads?q=")) {
        return jsonResponse({ threads: [{ id: "t1" }] });
      }
      if (path.includes("/threads/t1")) {
        return jsonResponse({
          id: "t1",
          messages: [
            {
              id: "m1",
              snippet: "see you then",
              payload: {
                headers: [
                  { name: "Subject", value: "Dinner" },
                  { name: "From", value: "Alice <alice@example.com>" },
                  { name: "Date", value: "Fri, 3 Jul 2026 10:00:00 +0200" },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGmailTools(user.id);
    const result = await (tools.search_threads as any).execute(
      { query: "from:alice", max_results: 5 },
      {}
    );
    expect(result.threads).toEqual([
      {
        thread_id: "t1",
        subject: "Dinner",
        from: "Alice <alice@example.com>",
        date: "Fri, 3 Jul 2026 10:00:00 +0200",
        message_count: 1,
        snippet: "see you then",
      },
    ]);
    // The search URL carries the query and cap.
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=from%3Aalice&maxResults=5");
  });

  it("surfaces auth problems as a tool error result instead of throwing", async () => {
    const user = await makeUser("Nova");
    const tools = buildGmailTools(user.id);
    const result = await (tools.list_labels as any).execute({}, {});
    expect(result.error).toContain("not connected");
  });
});
