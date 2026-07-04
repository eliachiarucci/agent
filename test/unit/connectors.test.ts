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
  extractAttachments,
  extractMessageBody,
  extractRawBody,
  gmailToolInfo,
} from "../../lib/agent/connectors/gmail";
import { buildConnectorTools } from "../../lib/agent/connectors";
import {
  getConnectorSetting,
  setConnectorTokens,
  upsertConnectorSetting,
} from "../../lib/db/connectors";
import { getToolPermissions, upsertToolPermissions } from "../../lib/db/tool-permissions";
import {
  addToolApprovals,
  deleteToolApproval,
  isToolCallApproved,
  listToolApprovals,
} from "../../lib/db/tool-approvals";
import { closeDb, makeUser, makeUserWithAgent, resetDb } from "../helpers/db";
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
  const { user, agent } = await makeUserWithAgent("Connie");
  await upsertConnectorSetting(user.id, "gmail", CREDS);
  await setConnectorTokens(user.id, "gmail", tokens(overrides), "connected");
  return { user, agent };
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
    const { user } = await connectedUser();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getConnectorAccessToken(user.id, "gmail")).resolves.toBe("access-1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired token and persists the result", async () => {
    const { user } = await connectedUser({ accessTokenExpiresAt: Date.now() - 1000 });
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
    const { user } = await connectedUser({ accessTokenExpiresAt: Date.now() - 1000 });
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
    const { user } = await connectedUser({ accessTokenExpiresAt: Date.now() - 1000 });
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

  it("normalizes CRLF and collapses blank-line runs in plain bodies", () => {
    const body = extractMessageBody({
      mimeType: "text/plain",
      body: { data: b64("hi\r\n\r\n\r\n\r\nthere\r\n") },
    });
    expect(body).toBe("hi\n\nthere");
  });

  it("never mistakes an attached text file for the message body", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("real body") } },
        {
          mimeType: "text/plain",
          filename: "notes.txt",
          body: { data: b64("attached file content"), size: 21 },
        },
      ],
    };
    expect(extractMessageBody(payload)).toBe("real body");
    expect(extractRawBody(payload)).toBe("real body");
  });

  it("lists attachments and inline images without inlining their content", () => {
    const attachments = extractAttachments({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", body: { data: b64("body") } },
        {
          mimeType: "application/pdf",
          filename: "invoice.pdf",
          body: { attachmentId: "att-1", size: 12345 },
        },
        // Inline image referenced by cid: — attachmentId but no top-level data.
        {
          mimeType: "image/png",
          filename: "logo.png",
          body: { attachmentId: "att-2", size: 999 },
        },
      ],
    });
    expect(attachments).toEqual([
      { filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 12345 },
      { filename: "logo.png", mimeType: "image/png", sizeBytes: 999 },
    ]);
    expect(extractAttachments({ mimeType: "text/plain", body: { data: b64("x") } })).toEqual([]);
  });

  it("raw extraction returns the original html source uncleaned", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [{ mimeType: "text/html", body: { data: b64("<p>hello <b>there</b></p>") } }],
    };
    expect(extractMessageBody(payload)).toBe("hello there");
    expect(extractRawBody(payload)).toBe("<p>hello <b>there</b></p>");
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
  it("defaults to {} and round-trips saves per (user, agent)", async () => {
    const { user, agent } = await makeUserWithAgent("Perm");
    const { agent: other } = await makeUserWithAgent("Perm2");
    expect(await getToolPermissions(user.id, agent.id)).toEqual({});

    await upsertToolPermissions(user.id, agent.id, {
      gmail: { create_draft: "deny", get_thread: "ask" },
    });
    expect(await getToolPermissions(user.id, agent.id)).toEqual({
      gmail: { create_draft: "deny", get_thread: "ask" },
    });
    // Other agents are unaffected.
    expect(await getToolPermissions(user.id, other.id)).toEqual({});

    // Saving again replaces the map.
    await upsertToolPermissions(user.id, agent.id, { gmail: {} });
    expect(await getToolPermissions(user.id, agent.id)).toEqual({ gmail: {} });
  });

  it('filters gmail tools: missing keys mean allow; headless withholds "ask" like "deny"', () => {
    // send_email is the one catalog entry whose unset default is "ask", so a
    // headless run with no saved levels gets everything except it.
    const all = buildGmailTools("user-1");
    expect(all.send_email).toBeUndefined();
    expect(Object.keys(all).sort()).toEqual(
      gmailToolInfo
        .filter((t) => t.name !== "send_email")
        .map((t) => t.name)
        .sort()
    );

    // No approval scope (headless, e.g. cron): nobody is there to ask.
    const filtered = buildGmailTools("user-1", {
      create_draft: "deny",
      get_thread: "ask",
      search_threads: "allow",
    });
    expect(filtered.create_draft).toBeUndefined();
    expect(filtered.get_thread).toBeUndefined();
    expect(filtered.send_email).toBeUndefined();
    expect(filtered.search_threads).toBeDefined();
    expect(Object.keys(filtered)).toHaveLength(gmailToolInfo.length - 3);

    // An explicit "allow" overrides send_email's "ask" default, even headless.
    const allowed = buildGmailTools("user-1", { send_email: "allow" });
    expect(allowed.send_email).toBeDefined();
    expect(allowed.send_email?.needsApproval).toBeUndefined();
  });

  it('send_email defaults to "ask": offered with a needsApproval gate in interactive runs', async () => {
    const { user, agent } = await makeUserWithAgent("Sender");
    const tools = buildGmailTools(user.id, undefined, { agentId: agent.id });
    expect(tools.send_email).toBeDefined();
    const needsApproval = tools.send_email?.needsApproval as (input: unknown) => Promise<boolean>;
    expect(typeof needsApproval).toBe("function");

    const input = { to: ["John@Doe.com"], subject: "hi", body: "hello" };
    expect(await needsApproval(input)).toBe(true);

    // Standing approvals target recipients, exactly like create_draft.
    await addToolApprovals({
      userId: user.id,
      agentId: agent.id,
      connector: "gmail",
      tool: "send_email",
      targets: ["john@doe.com"],
    });
    expect(await needsApproval(input)).toBe(false);
    expect(await needsApproval({ ...input, cc: ["jane@doe.com"] })).toBe(true);
  });

  it('offers "ask" tools with a needsApproval gate in interactive runs', async () => {
    const { user, agent } = await makeUserWithAgent("Asker");
    const tools = buildGmailTools(
      user.id,
      { create_draft: "ask", get_thread: "deny" },
      { agentId: agent.id }
    );
    expect(tools.get_thread).toBeUndefined();
    expect(tools.create_draft).toBeDefined();
    expect(tools.search_threads?.needsApproval).toBeUndefined();

    const needsApproval = tools.create_draft?.needsApproval as (input: unknown) => Promise<boolean>;
    expect(typeof needsApproval).toBe("function");

    // No standing approval → ask.
    const input = { to: ["John@Doe.com"], subject: "hi", body: "hello" };
    expect(await needsApproval(input)).toBe(true);

    // A standing approval for the (tool, target) combination skips the prompt;
    // recipients are matched case-insensitively.
    await addToolApprovals({
      userId: user.id,
      agentId: agent.id,
      connector: "gmail",
      tool: "create_draft",
      targets: ["john@doe.com"],
    });
    expect(await needsApproval(input)).toBe(false);
    // A recipient outside the approved set still asks.
    expect(await needsApproval({ ...input, cc: ["jane@doe.com"] })).toBe(true);
  });
});

describe("tool approvals (standing overrides)", () => {
  it("matches only when every target is covered; wildcard covers everything", async () => {
    const { user, agent } = await makeUserWithAgent("Ova");
    const base = { userId: user.id, agentId: agent.id, connector: "gmail" as const };

    // Untargeted tool ("targets: null") stores a wildcard row.
    await addToolApprovals({ ...base, tool: "create_label", targets: null });
    expect(await isToolCallApproved({ ...base, tool: "create_label", targets: null })).toBe(true);
    expect(await isToolCallApproved({ ...base, tool: "label_message", targets: null })).toBe(false);

    await addToolApprovals({ ...base, tool: "create_draft", targets: ["a@x.com", "b@x.com"] });
    expect(
      await isToolCallApproved({ ...base, tool: "create_draft", targets: ["a@x.com"] })
    ).toBe(true);
    expect(
      await isToolCallApproved({ ...base, tool: "create_draft", targets: ["a@x.com", "b@x.com"] })
    ).toBe(true);
    expect(
      await isToolCallApproved({ ...base, tool: "create_draft", targets: ["a@x.com", "c@x.com"] })
    ).toBe(false);
    // A targeted tool with no derivable targets is not covered by target rows.
    expect(await isToolCallApproved({ ...base, tool: "create_draft", targets: [] })).toBe(false);

    // Re-approving the same combination is a no-op, not an error.
    await addToolApprovals({ ...base, tool: "create_draft", targets: ["a@x.com"] });

    // Scoped per user+agent.
    const { agent: other } = await makeUserWithAgent("Ovb");
    expect(
      await isToolCallApproved({
        ...base,
        agentId: other.id,
        tool: "create_draft",
        targets: ["a@x.com"],
      })
    ).toBe(false);
  });

  it("lists and deletes only the owner's rows", async () => {
    const { user, agent } = await makeUserWithAgent("Del");
    const stranger = await makeUser("Str");
    await addToolApprovals({
      userId: user.id,
      agentId: agent.id,
      connector: "gmail",
      tool: "create_draft",
      targets: ["a@x.com"],
    });
    const [row] = await listToolApprovals(user.id, agent.id);
    expect(row).toMatchObject({ tool: "create_draft", target: "a@x.com" });

    expect(await deleteToolApproval(row.id, stranger.id)).toBe(false);
    expect(await deleteToolApproval(row.id, user.id)).toBe(true);
    expect(await listToolApprovals(user.id, agent.id)).toHaveLength(0);
  });
});

describe("buildConnectorTools", () => {
  it("offers nothing when gmail is not connected or errored", async () => {
    const { user, agent } = await makeUserWithAgent("Uma");
    let result = await buildConnectorTools({ userId: user.id, agentId: agent.id });
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.prompt).toBe("");

    await upsertConnectorSetting(user.id, "gmail", CREDS);
    result = await buildConnectorTools({ userId: user.id, agentId: agent.id });
    expect(Object.keys(result.tools)).toHaveLength(0);

    await setConnectorTokens(user.id, "gmail", tokens(), "error");
    result = await buildConnectorTools({ userId: user.id, agentId: agent.id });
    expect(Object.keys(result.tools)).toHaveLength(0);
  });

  it("offers permission-filtered tools and the gmail prompt when connected", async () => {
    const { user, agent } = await connectedUser();
    const { agent: other } = await makeUserWithAgent("Otto");
    await upsertToolPermissions(user.id, agent.id, {
      gmail: { label_thread: "deny", unlabel_thread: "ask" },
    });

    // Headless: the two saved levels are withheld, plus send_email's "ask" default.
    const result = await buildConnectorTools({ userId: user.id, agentId: agent.id });
    expect(result.prompt).toContain("## Gmail");
    expect(result.prompt).toContain("you can never send");
    expect(result.tools.search_threads).toBeDefined();
    expect(result.tools.label_thread).toBeUndefined();
    expect(result.tools.unlabel_thread).toBeUndefined();
    expect(Object.keys(result.tools)).toHaveLength(gmailToolInfo.length - 3);

    // Interactive (chat): "ask" tools are offered, gated by needsApproval, and
    // the prompt's send guidance flips with send_email available.
    const interactive = await buildConnectorTools({
      userId: user.id,
      agentId: agent.id,
      interactive: true,
    });
    expect(interactive.tools.label_thread).toBeUndefined();
    expect(interactive.tools.unlabel_thread).toBeDefined();
    expect(interactive.tools.unlabel_thread?.needsApproval).toBeDefined();
    expect(interactive.tools.send_email).toBeDefined();
    expect(interactive.prompt).not.toContain("you can never send");
    expect(interactive.prompt).toContain("send_email sends immediately");

    // A different agent has no levels saved → full toolset minus the
    // default-"ask" send_email (headless run).
    const full = await buildConnectorTools({ userId: user.id, agentId: other.id });
    expect(Object.keys(full.tools)).toHaveLength(gmailToolInfo.length - 1);
  });

  it("withholds the prompt when every tool is denied", async () => {
    const { user, agent } = await connectedUser();
    await upsertToolPermissions(user.id, agent.id, {
      gmail: Object.fromEntries(gmailToolInfo.map((t) => [t.name, "deny" as const])),
    });
    const result = await buildConnectorTools({ userId: user.id, agentId: agent.id });
    expect(Object.keys(result.tools)).toHaveLength(0);
    expect(result.prompt).toBe("");
  });
});

describe("gmail tools against a stubbed API", () => {
  it("search_threads lists and summarizes threads", async () => {
    const { user } = await connectedUser();
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

  it("get_thread cleans bodies, lists attachments, and honors raw", async () => {
    const { user } = await connectedUser();
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: "t1",
          messages: [
            {
              id: "m1",
              labelIds: ["INBOX"],
              payload: {
                headers: [
                  { name: "From", value: "Alice <alice@example.com>" },
                  { name: "Subject", value: "Photos" },
                ],
                mimeType: "multipart/mixed",
                parts: [
                  { mimeType: "text/html", body: { data: b64("<p>see <b>attached</b></p>") } },
                  {
                    mimeType: "image/jpeg",
                    filename: "cat.jpg",
                    body: { attachmentId: "a1", size: 4096 },
                  },
                ],
              },
            },
          ],
        })
      )
    );

    const tools = buildGmailTools(user.id);
    const clean = await (tools.get_thread as any).execute({ thread_id: "t1", raw: false }, {});
    expect(clean.messages[0].body).toBe("see attached");
    expect(clean.messages[0].attachments).toEqual([
      { filename: "cat.jpg", mimeType: "image/jpeg", sizeBytes: 4096 },
    ]);

    const raw = await (tools.get_thread as any).execute({ thread_id: "t1", raw: true }, {});
    expect(raw.messages[0].body).toBe("<p>see <b>attached</b></p>");
  });

  it("send_email posts to /messages/send with reply threading headers", async () => {
    const { user } = await connectedUser();
    const fetchMock = vi.fn(async (url: any) => {
      const path = String(url);
      if (path.includes("/messages/m1?")) {
        return jsonResponse({
          id: "m1",
          threadId: "t1",
          payload: {
            headers: [
              { name: "Message-ID", value: "<orig@example.com>" },
              { name: "References", value: "<root@example.com>" },
            ],
          },
        });
      }
      if (path.endsWith("/messages/send")) {
        return jsonResponse({ id: "m2", threadId: "t1" });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools = buildGmailTools(user.id, { send_email: "allow" });
    const result = await (tools.send_email as any).execute(
      {
        to: ["alice@example.com"],
        subject: "Re: Dinner",
        body: "See you then!",
        reply_to_message_id: "m1",
      },
      {}
    );
    expect(result).toEqual({ message_id: "m2", thread_id: "t1", note: "Email sent." });

    const sendCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/messages/send"));
    const payload = JSON.parse(String(sendCall![1].body));
    expect(payload.threadId).toBe("t1");
    const mime = Buffer.from(payload.raw, "base64url").toString("utf8");
    expect(mime).toContain("To: alice@example.com");
    expect(mime).toContain("In-Reply-To: <orig@example.com>");
    expect(mime).toContain("References: <root@example.com> <orig@example.com>");
  });

  it("surfaces auth problems as a tool error result instead of throwing", async () => {
    const user = await makeUser("Nova");
    const tools = buildGmailTools(user.id);
    const result = await (tools.list_labels as any).execute({}, {});
    expect(result.error).toContain("not connected");
  });
});
