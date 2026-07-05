import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { convert } from "html-to-text";
import { ConnectorAuthError, getConnectorAccessToken } from "./google-auth";
import { isToolCallApproved } from "../../db/tool-approvals";
import type { ToolPermissionLevel } from "../../global/schema";

// Env-overridable so tests can stub the Gmail API with a local server.
const GMAIL_API_BASE =
  process.env.GMAIL_API_BASE ?? "https://gmail.googleapis.com/gmail/v1/users/me";

const FETCH_TIMEOUT_MS = 20_000;
// Keeps tool results small enough for local-model context windows: per-message
// body cap and a whole-thread budget (Gmail threads can be enormous).
const MAX_BODY_CHARS = 10_000;
const MAX_THREAD_CHARS = 40_000;
const MAX_SEARCH_RESULTS = 25;

// What connecting Gmail asks for. gmail.compose covers drafts *and* sending,
// so send_email needs no extra scope or reconsent — the guard against unwanted
// sends is the permission system (write tools default to "ask"), not the
// scope. openid+email identify the connected account in the UI.
export const GMAIL_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.labels",
];

// The permission catalog the settings UI renders toggles from. Names mirror
// Claude's official Gmail connector so the surface feels familiar.
// `defaultLevel` is the level applied when the user never saved one — i.e.
// what a freshly created agent gets: read tools start at "allow", write tools
// at "ask" so no agent can mutate the mailbox without a human approving each
// call until its owner explicitly allows it.
export type ConnectorToolKind = "read" | "write";
export type ConnectorToolInfo = {
  name: string;
  kind: ConnectorToolKind;
  description: string;
  defaultLevel: ToolPermissionLevel;
};

const read = (name: string, description: string): ConnectorToolInfo => ({
  name,
  kind: "read",
  description,
  defaultLevel: "allow",
});
const write = (name: string, description: string): ConnectorToolInfo => ({
  name,
  kind: "write",
  description,
  defaultLevel: "ask",
});

export const gmailToolInfo: ConnectorToolInfo[] = [
  read("search_threads", "Search emails with Gmail query syntax"),
  read("get_thread", "Read a full email thread"),
  read("list_labels", "List the mailbox's labels"),
  read("list_drafts", "List existing drafts"),
  write("create_draft", "Create a draft email (never sends)"),
  write("send_email", "Send an email from the connected account"),
  write("create_label", "Create a new label"),
  write("label_message", "Add labels to a message"),
  write("unlabel_message", "Remove labels from a message"),
  write("label_thread", "Add labels to a thread"),
  write("unlabel_thread", "Remove labels from a thread"),
];

// ── Gmail REST helpers ───────────────────────────────────────────────────────

async function gmailFetch<T>(userId: string, path: string, init?: RequestInit): Promise<T> {
  const token = await getConnectorAccessToken(userId, "gmail");
  const res = await fetch(`${GMAIL_API_BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API error ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// Errors become tool results (matching the searchTools style) so the model can
// react — e.g. tell the user to reconnect — instead of the turn crashing.
async function run<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConnectorAuthError) return { error: err.message };
    return { error: err instanceof Error ? err.message : "Gmail request failed" };
  }
}

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
};
type GmailThread = { id?: string; messages?: GmailMessage[] };

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function decodeBody(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

// A MIME part that is a file (attachment or inline image), not body text.
// Filenames mark explicit attachments; attachmentId also catches inline images
// referenced by cid: in the HTML.
function isAttachmentPart(part: GmailPart): boolean {
  return Boolean(part.filename || part.body?.attachmentId);
}

// Body parts of the wanted mime type, decoded — attachments excluded, so an
// attached .txt/.html file never gets mistaken for the message body.
function collectBodyParts(payload: GmailPart, want: string): string[] {
  const out: string[] = [];
  if (!isAttachmentPart(payload) && payload.mimeType?.startsWith(want) && payload.body?.data) {
    out.push(decodeBody(payload.body.data));
  }
  for (const child of payload.parts ?? []) out.push(...collectBodyParts(child, want));
  return out;
}

function tidy(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The message body as readable text: prefers text/plain, falls back to
// text/html converted to plain text (links kept as their text, images and
// styling dropped). Multipart containers recurse.
export function extractMessageBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const plain = collectBodyParts(payload, "text/plain").join("\n");
  if (plain.trim()) return tidy(plain);
  const html = collectBodyParts(payload, "text/html").join("\n");
  if (!html.trim()) return "";
  return tidy(
    convert(html, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
        { selector: "style", format: "skip" },
        { selector: "script", format: "skip" },
      ],
    })
  );
}

// The original body content untouched: text/plain as sent plus the HTML
// source, for the rare case where the cleaned text loses something the agent
// needs (get_thread's raw option; off by default).
export function extractRawBody(payload: GmailPart | undefined): string {
  if (!payload) return "";
  return [...collectBodyParts(payload, "text/plain"), ...collectBodyParts(payload, "text/html")]
    .join("\n\n")
    .trim();
}

export type EmailAttachment = { filename: string; mimeType?: string; sizeBytes?: number };

// Attachments and inline images, listed so the agent knows they exist even
// though their bytes are never inlined into the context.
export function extractAttachments(payload: GmailPart | undefined): EmailAttachment[] {
  if (!payload) return [];
  const out: EmailAttachment[] = [];
  const walk = (part: GmailPart) => {
    if (isAttachmentPart(part)) {
      out.push({
        filename: part.filename || "(unnamed)",
        mimeType: part.mimeType,
        sizeBytes: part.body?.size,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return out;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

// ── Draft assembly (RFC 2822) ────────────────────────────────────────────────

function encodeMimeWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildRawEmail(opts: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const lines = [
    `To: ${opts.to.join(", ")}`,
    ...(opts.cc?.length ? [`Cc: ${opts.cc.join(", ")}`] : []),
    ...(opts.bcc?.length ? [`Bcc: ${opts.bcc.join(", ")}`] : []),
    `Subject: ${encodeMimeWord(opts.subject)}`,
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.references ? [`References: ${opts.references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(opts.body, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

// Threading headers for a reply: Gmail threads a message correctly only when
// it carries the original's Message-ID in In-Reply-To/References and is filed
// under the same threadId. Shared by create_draft and send_email.
async function replyThreading(userId: string, replyToMessageId: string) {
  const original = await gmailFetch<GmailMessage>(
    userId,
    `/messages/${replyToMessageId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`
  );
  const inReplyTo = header(original.payload?.headers, "Message-ID");
  const prior = header(original.payload?.headers, "References");
  return {
    threadId: original.threadId,
    inReplyTo,
    references: [prior, inReplyTo].filter(Boolean).join(" ") || undefined,
  };
}

// ── Result shaping ───────────────────────────────────────────────────────────

function summarizeThread(thread: GmailThread) {
  const messages = thread.messages ?? [];
  const first = messages[0]?.payload?.headers;
  const last = messages[messages.length - 1]?.payload?.headers;
  return {
    thread_id: thread.id,
    subject: header(first, "Subject") ?? "(no subject)",
    from: header(last, "From"),
    date: header(last, "Date"),
    message_count: messages.length,
    snippet: messages[messages.length - 1]?.snippet,
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────

function allGmailTools(userId: string): ToolSet {
  return {
    search_threads: tool({
      description:
        "Search the user's Gmail with Gmail query syntax (e.g. from:alice@example.com, subject:invoice, newer_than:7d, is:unread, has:attachment, label:work). Returns matching threads; use get_thread to read one.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Gmail search query, same syntax as the Gmail search box"),
        max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(10),
      }),
      execute: ({ query, max_results }) =>
        run(async () => {
          const list = await gmailFetch<{ threads?: { id: string }[] }>(
            userId,
            `/threads?q=${encodeURIComponent(query)}&maxResults=${max_results}`
          );
          const ids = (list.threads ?? []).map((t) => t.id);
          if (ids.length === 0) return { threads: [], note: "No matching threads." };
          const threads = await Promise.all(
            ids.map((id) =>
              gmailFetch<GmailThread>(
                userId,
                `/threads/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`
              )
            )
          );
          return { threads: threads.map(summarizeThread) };
        }),
    }),

    get_thread: tool({
      description:
        "Read a full Gmail thread (all messages) by thread_id from search_threads. Bodies are cleaned to readable plain text and attachments/inline images are listed by name (their content is not included). Pass raw: true only if the cleaned text seems to be missing something — it returns the original body source instead.",
      inputSchema: z.object({
        thread_id: z.string().min(1),
        raw: z
          .boolean()
          .default(false)
          .describe(
            "Return the original unprocessed body (plain text as sent plus HTML source) instead of cleaned text. Off by default; the raw source is much longer and harder to read."
          ),
      }),
      execute: ({ thread_id, raw }) =>
        run(async () => {
          const thread = await gmailFetch<GmailThread>(userId, `/threads/${thread_id}?format=full`);
          let budget = MAX_THREAD_CHARS;
          const messages = (thread.messages ?? []).map((m) => {
            const headers = m.payload?.headers;
            let body = truncate(
              raw ? extractRawBody(m.payload) : extractMessageBody(m.payload),
              MAX_BODY_CHARS
            );
            if (body.length > budget) body = "[body omitted — thread too large]";
            budget = Math.max(0, budget - body.length);
            const attachments = extractAttachments(m.payload);
            return {
              message_id: m.id,
              from: header(headers, "From"),
              to: header(headers, "To"),
              cc: header(headers, "Cc"),
              date: header(headers, "Date"),
              subject: header(headers, "Subject"),
              labels: m.labelIds,
              body,
              ...(attachments.length > 0 ? { attachments } : {}),
            };
          });
          return { thread_id: thread.id, messages };
        }),
    }),

    list_labels: tool({
      description: "List the Gmail mailbox's labels (system and user-created) with their ids.",
      inputSchema: z.object({}),
      execute: () =>
        run(async () => {
          const res = await gmailFetch<{ labels?: { id: string; name: string; type?: string }[] }>(
            userId,
            "/labels"
          );
          return {
            labels: (res.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
          };
        }),
    }),

    list_drafts: tool({
      description: "List the user's existing Gmail drafts.",
      inputSchema: z.object({
        max_results: z.number().int().min(1).max(MAX_SEARCH_RESULTS).default(10),
      }),
      execute: ({ max_results }) =>
        run(async () => {
          const list = await gmailFetch<{ drafts?: { id: string; message?: { id: string } }[] }>(
            userId,
            `/drafts?maxResults=${max_results}`
          );
          const drafts = await Promise.all(
            (list.drafts ?? []).map(async (d) => {
              const full = await gmailFetch<{ id: string; message?: GmailMessage }>(
                userId,
                `/drafts/${d.id}?format=metadata`
              );
              const headers = full.message?.payload?.headers;
              return {
                draft_id: d.id,
                to: header(headers, "To"),
                subject: header(headers, "Subject"),
                snippet: full.message?.snippet,
              };
            })
          );
          return { drafts };
        }),
    }),

    create_draft: tool({
      description:
        "Create a Gmail draft. The draft is saved to the user's Drafts folder for them to review and send — this tool never sends email. To draft a reply, pass reply_to_message_id from get_thread so Gmail threads it correctly.",
      inputSchema: z.object({
        to: z.array(z.string().min(3)).min(1).describe("Recipient email addresses"),
        cc: z.array(z.string().min(3)).optional(),
        bcc: z.array(z.string().min(3)).optional(),
        subject: z.string(),
        body: z.string().min(1).describe("Plain-text body"),
        reply_to_message_id: z
          .string()
          .optional()
          .describe("message_id of the message being replied to, for threading"),
      }),
      execute: ({ to, cc, bcc, subject, body, reply_to_message_id }) =>
        run(async () => {
          const { threadId, inReplyTo, references } = reply_to_message_id
            ? await replyThreading(userId, reply_to_message_id)
            : { threadId: undefined, inReplyTo: undefined, references: undefined };
          const raw = buildRawEmail({ to, cc, bcc, subject, body, inReplyTo, references });
          const draft = await gmailFetch<{ id: string }>(userId, "/drafts", {
            method: "POST",
            body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
          });
          return {
            draft_id: draft.id,
            note: "Draft created. The user can review and send it from Gmail.",
          };
        }),
    }),

    send_email: tool({
      description:
        "Send an email from the user's Gmail account immediately — there is no review step, so only use it when the user asked to send (otherwise prefer create_draft). To send a reply, pass reply_to_message_id from get_thread so Gmail threads it correctly.",
      inputSchema: z.object({
        to: z.array(z.string().min(3)).min(1).describe("Recipient email addresses"),
        cc: z.array(z.string().min(3)).optional(),
        bcc: z.array(z.string().min(3)).optional(),
        subject: z.string(),
        body: z.string().min(1).describe("Plain-text body"),
        reply_to_message_id: z
          .string()
          .optional()
          .describe("message_id of the message being replied to, for threading"),
      }),
      execute: ({ to, cc, bcc, subject, body, reply_to_message_id }) =>
        run(async () => {
          const { threadId, inReplyTo, references } = reply_to_message_id
            ? await replyThreading(userId, reply_to_message_id)
            : { threadId: undefined, inReplyTo: undefined, references: undefined };
          const raw = buildRawEmail({ to, cc, bcc, subject, body, inReplyTo, references });
          const sent = await gmailFetch<{ id: string; threadId?: string }>(
            userId,
            "/messages/send",
            {
              method: "POST",
              body: JSON.stringify({ raw, ...(threadId ? { threadId } : {}) }),
            }
          );
          return { message_id: sent.id, thread_id: sent.threadId, note: "Email sent." };
        }),
    }),

    create_label: tool({
      description: "Create a new Gmail label.",
      inputSchema: z.object({ name: z.string().min(1) }),
      execute: ({ name }) =>
        run(async () => {
          const label = await gmailFetch<{ id: string; name: string }>(userId, "/labels", {
            method: "POST",
            body: JSON.stringify({
              name,
              labelListVisibility: "labelShow",
              messageListVisibility: "show",
            }),
          });
          return { id: label.id, name: label.name };
        }),
    }),

    label_message: tool({
      description: "Add labels to a Gmail message by label id (see list_labels).",
      inputSchema: z.object({
        message_id: z.string().min(1),
        label_ids: z.array(z.string().min(1)).min(1),
      }),
      execute: ({ message_id, label_ids }) =>
        run(() => modifyLabels(userId, "messages", message_id, { addLabelIds: label_ids })),
    }),
    unlabel_message: tool({
      description:
        "Remove labels from a Gmail message by label id. Removing INBOX archives it; removing UNREAD marks it as read.",
      inputSchema: z.object({
        message_id: z.string().min(1),
        label_ids: z.array(z.string().min(1)).min(1),
      }),
      execute: ({ message_id, label_ids }) =>
        run(() => modifyLabels(userId, "messages", message_id, { removeLabelIds: label_ids })),
    }),
    label_thread: tool({
      description: "Add labels to a Gmail thread by label id (see list_labels).",
      inputSchema: z.object({
        thread_id: z.string().min(1),
        label_ids: z.array(z.string().min(1)).min(1),
      }),
      execute: ({ thread_id, label_ids }) =>
        run(() => modifyLabels(userId, "threads", thread_id, { addLabelIds: label_ids })),
    }),
    unlabel_thread: tool({
      description:
        "Remove labels from a Gmail thread by label id. Removing INBOX archives it; removing UNREAD marks it as read.",
      inputSchema: z.object({
        thread_id: z.string().min(1),
        label_ids: z.array(z.string().min(1)).min(1),
      }),
      execute: ({ thread_id, label_ids }) =>
        run(() => modifyLabels(userId, "threads", thread_id, { removeLabelIds: label_ids })),
    }),
  };
}

async function modifyLabels(
  userId: string,
  target: "messages" | "threads",
  id: string,
  body: { addLabelIds?: string[]; removeLabelIds?: string[] }
) {
  await gmailFetch(userId, `/${target}/${id}/modify`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { ok: true };
}

// The "target" of a call, for approval overrides: the user can approve a
// (tool, target) combination once and have future matching calls run without
// asking. Tools without an entry have no target concept — their override is
// tool-wide. Kept per tool so new targeted tools only need a row here.
function recipientTargets(input: unknown): string[] {
  const { to, cc, bcc } = input as { to?: string[]; cc?: string[]; bcc?: string[] };
  return [...(to ?? []), ...(cc ?? []), ...(bcc ?? [])].map((email) => email.trim().toLowerCase());
}

const gmailApprovalTargets: Record<string, (input: unknown) => string[]> = {
  create_draft: recipientTargets,
  send_email: recipientTargets,
};

/** Approval targets for one call: string list, or null when the tool is untargeted. */
export function gmailApprovalTargetsFor(toolName: string, input: unknown): string[] | null {
  return gmailApprovalTargets[toolName]?.(input) ?? null;
}

// The level applied when the user never saved one for a tool: the catalog's
// defaultLevel ("allow" for reads, "ask" for writes) — the settings UI
// mirrors this fallback.
const gmailDefaultLevels: Record<string, ToolPermissionLevel> = Object.fromEntries(
  gmailToolInfo.map((t) => [t.name, t.defaultLevel])
);

/**
 * The Gmail toolset for a user, filtered by the per-agent permission map
 * (tool name → level; missing = the tool's catalog default: "allow" for read
 * tools, "ask" for write tools). "ask" tools get a `needsApproval`
 * check: standing (tool, target) approvals let the call run directly, anything
 * else pauses the stream for the user to approve or deny in the UI. Headless
 * runs (no `approval` scope, e.g. cron) withhold "ask" tools like "deny" —
 * a tool the user gated must not run with nobody there to ask.
 */
export function buildGmailTools(
  userId: string,
  permissions?: Record<string, ToolPermissionLevel>,
  approval?: { agentId: string }
): ToolSet {
  const tools = allGmailTools(userId);
  return Object.fromEntries(
    Object.entries(tools).flatMap(([name, definition]) => {
      const level = permissions?.[name] ?? gmailDefaultLevels[name] ?? "allow";
      if (level === "allow") return [[name, definition]];
      if (level !== "ask" || !approval) return [];
      return [
        [
          name,
          {
            ...definition,
            needsApproval: async (input: unknown) =>
              !(await isToolCallApproved({
                userId,
                agentId: approval.agentId,
                connector: "gmail",
                tool: name,
                targets: gmailApprovalTargetsFor(name, input),
              })),
          },
        ],
      ];
    })
  );
}

// The Gmail system-prompt section, phrased for the toolset actually offered:
// the send guidance must not promise "you can never send" when send_email is
// available, nor mention drafting/sending/labeling when those tools were
// denied or withheld (write tools default to "ask", so headless runs offer
// only read tools unless explicitly allowed). Stable per (user, agent,
// settings), so the KV-cache prefix rule holds.
export function gmailPromptFor(tools: ToolSet): string {
  const sendLine =
    "send_email" in tools
      ? "- create_draft prepares an email for the user to review and send from Gmail; send_email sends immediately with no review step. Default to create_draft — only send when the user asked you to send."
      : "create_draft" in tools
        ? "- You can prepare emails with create_draft, but you can never send: drafts wait in Gmail for the user to review and send. Say so when you hand one off."
        : null;
  const labelTools = ["create_label", "label_message", "unlabel_message", "label_thread", "unlabel_thread"];
  const labelLine = labelTools.some((name) => name in tools)
    ? "- You can organize mail with labels (list_labels, create_label, label/unlabel tools). Removing INBOX archives a thread; removing UNREAD marks it read."
    : null;
  return [
    "## Gmail",
    "- You are connected to the user's Gmail. search_threads finds email (full Gmail query syntax); get_thread reads one.",
    "- get_thread returns bodies cleaned to readable text, and lists attachments/inline images by name (you cannot open them). Pass raw: true only when the cleaned text seems to be missing content you need.",
    labelLine,
    sendLine,
    "- Quote email content faithfully and cite the sender/date when summarizing.",
  ]
    .filter(Boolean)
    .join("\n");
}
