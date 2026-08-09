import { tool } from "ai";
import { z } from "zod";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Conversation artifacts are plain files on disk, one folder per conversation
// (FILES_DIR/<conversation id>/<name>), so each conversation maps to exactly
// one folder. Nothing is duplicated into Postgres: visibility derives from the
// conversation the folder belongs to (whoever can read the conversation can
// read its files), and the folder is removed together with the conversation.
// Files the user uploads (images, pasted content) live in an "uploads/"
// subfolder of the conversation's folder, so agent-written artifacts and user
// uploads stay distinguishable without any bookkeeping outside the filesystem.
const filesRoot = () => resolve(process.env.FILES_DIR ?? "data/files");

// Where a file came from: written by the agent's file tools, or uploaded by a
// user. Maps to the on-disk location (uploads live under uploads/).
export type FileSource = "agent" | "upload";
export const FILE_SOURCES = ["agent", "upload"] as const;
const UPLOADS_DIR = "uploads";

const sourceDir = (conversationId: string, source: FileSource) =>
  source === "upload"
    ? join(filesRoot(), conversationId, UPLOADS_DIR)
    : join(filesRoot(), conversationId);

// Image uploads the chat accepts, keyed by file extension. The set matches what
// the vision-capable providers take as image parts (PNG, JPEG, WebP, GIF).
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Media type for a supported image file name, or null when it isn't one. */
export function imageMediaTypeFor(name: string): string | null {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] ?? null;
}

// Bounds chosen for text artifacts written by a model, not user uploads.
const MAX_FILE_BYTES = 1024 * 1024;
// User uploads (pasted-content attachments today; documents and images next) get
// a larger ceiling than the model-written artifacts above, which are kept small
// for local-model context budgets.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_FILES_PER_CONVERSATION = 100;
// Keeps readFile tool results within local-model-friendly context budgets.
const MAX_READ_CHARS = 20_000;

const isEnoent = (error: unknown) =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

// A plain file name, never a path: rejecting separators, traversal and control
// characters keeps every file inside its conversation folder and safe to echo
// into a Content-Disposition header.
export function isValidFileName(name: string): boolean {
  const hasUnsafeChar = [...name].some(
    (char) => char === "/" || char === "\\" || char.charCodeAt(0) < 0x20
  );
  return (
    name.length > 0 &&
    name.length <= 128 &&
    !hasUnsafeChar &&
    name !== "." &&
    name !== ".." &&
    name === name.trim()
  );
}

export function conversationFilePath(
  conversationId: string,
  name: string,
  source: FileSource = "agent"
): string {
  if (!isValidFileName(name)) {
    throw new Error(
      `Invalid file name ${JSON.stringify(name)}: use a plain name with extension, without slashes`
    );
  }
  return join(sourceDir(conversationId, source), name);
}

export type ConversationFile = {
  name: string;
  size: number;
  updatedAt: Date;
  source: FileSource;
};

async function listSourceFiles(
  conversationId: string,
  source: FileSource
): Promise<ConversationFile[]> {
  const dir = sourceDir(conversationId, source);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const stats = await stat(join(dir, entry.name));
        return { name: entry.name, size: stats.size, updatedAt: stats.mtime, source };
      })
  );
}

export async function listConversationFiles(conversationId: string): Promise<ConversationFile[]> {
  const files = (
    await Promise.all(FILE_SOURCES.map((source) => listSourceFiles(conversationId, source)))
  ).flat();
  return files.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function statConversationFile(
  conversationId: string,
  name: string,
  source: FileSource = "agent"
): Promise<ConversationFile | null> {
  try {
    const stats = await stat(conversationFilePath(conversationId, name, source));
    if (!stats.isFile()) return null;
    return { name, size: stats.size, updatedAt: stats.mtime, source };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function readConversationFile(
  conversationId: string,
  name: string,
  source: FileSource = "agent"
): Promise<string | null> {
  try {
    return await readFile(conversationFilePath(conversationId, name, source), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** Raw bytes of a conversation file (image uploads); null when it doesn't exist. */
export async function readConversationFileBytes(
  conversationId: string,
  name: string,
  source: FileSource = "agent"
): Promise<Buffer | null> {
  try {
    return await readFile(conversationFilePath(conversationId, name, source));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

// Binary-safe core write, shared by the model's writeFile tool (UTF-8 text) and
// the upload endpoint (raw bytes). Enforces the size ceiling and the
// per-conversation file cap, then writes the bytes verbatim.
export async function writeConversationFileBytes(
  conversationId: string,
  name: string,
  data: Buffer,
  maxBytes: number = MAX_FILE_BYTES,
  source: FileSource = "agent"
): Promise<ConversationFile> {
  const path = conversationFilePath(conversationId, name, source);
  const size = data.byteLength;
  if (size > maxBytes) {
    throw new Error(`File too large (${size} bytes); the limit is ${maxBytes} bytes`);
  }
  // The file cap spans both sources: uploads and artifacts share the budget.
  const existing = await listConversationFiles(conversationId);
  if (
    existing.length >= MAX_FILES_PER_CONVERSATION &&
    !existing.some((file) => file.name === name && file.source === source)
  ) {
    throw new Error(
      `This conversation already has ${MAX_FILES_PER_CONVERSATION} files; update or reuse an existing one`
    );
  }
  await mkdir(sourceDir(conversationId, source), { recursive: true });
  await writeFile(path, data);
  return { name, size, updatedAt: new Date(), source };
}

export function writeConversationFile(
  conversationId: string,
  name: string,
  content: string
): Promise<ConversationFile> {
  return writeConversationFileBytes(conversationId, name, Buffer.from(content, "utf8"));
}

/** Replaces every occurrence of `oldText`; throws when the file or the text is missing. */
export async function editConversationFile(
  conversationId: string,
  name: string,
  oldText: string,
  newText: string
): Promise<{ replacements: number; size: number }> {
  const content = await readConversationFile(conversationId, name);
  if (content === null) {
    throw new Error(`File "${name}" does not exist; create it with writeFile first`);
  }
  const parts = content.split(oldText);
  if (parts.length === 1) {
    throw new Error(
      `old_text was not found in "${name}"; read the file and retry with an exact snippet`
    );
  }
  const file = await writeConversationFile(conversationId, name, parts.join(newText));
  return { replacements: parts.length - 1, size: file.size };
}

/** Deletes the conversation's folder; called when the conversation goes away. */
export async function removeConversationFiles(conversationId: string): Promise<void> {
  await rm(join(filesRoot(), conversationId), { recursive: true, force: true });
}

/** Deletes one user upload (e.g. an image detached before sending). */
export async function removeConversationUpload(
  conversationId: string,
  name: string
): Promise<boolean> {
  const path = conversationFilePath(conversationId, name, "upload");
  try {
    await rm(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

const fileNameSchema = z
  .string()
  .refine(isValidFileName, "Plain file name with extension, no slashes")
  .describe('File name with extension, e.g. "trip-plan.md". Plain name only, no folders.');

// Failures come back as values ({ error }) instead of throwing, so the model
// can read what went wrong and correct itself (same pattern as searchTools).
async function asToolResult<T extends object>(
  action: () => Promise<T>
): Promise<T | { error: string }> {
  try {
    return await action();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "File operation failed" };
  }
}

// Built per request: the closure pins every operation to the current
// conversation's folder. Schemas are static, so the prompt prefix stays
// KV-cache friendly (see docs/memory.md).
export function buildFileTools(conversationId: string) {
  return {
    writeFile: tool({
      description:
        "Create a file in this conversation's workspace, or replace the content of an existing one. Use files for deliverables the user will keep, download, or iterate on (documents, code, plans, lists).",
      inputSchema: z.object({
        name: fileNameSchema,
        content: z
          .string()
          .describe("The complete file content; it replaces whatever the file contained before."),
      }),
      execute: ({ name, content }) =>
        asToolResult(async () => {
          const file = await writeConversationFile(conversationId, name, content);
          return { name: file.name, size: file.size };
        }),
    }),

    editFile: tool({
      description:
        "Modify an existing file by replacing an exact text snippet. Prefer this over writeFile for small changes, so the rest of the file is preserved untouched.",
      inputSchema: z.object({
        name: fileNameSchema,
        old_text: z
          .string()
          .min(1)
          .describe("Exact text currently in the file; every occurrence is replaced."),
        new_text: z.string().describe("The replacement text."),
      }),
      execute: ({ name, old_text, new_text }) =>
        asToolResult(() => editConversationFile(conversationId, name, old_text, new_text)),
    }),

    readFile: tool({
      description:
        "Read a file from this conversation's workspace, e.g. before editing it or to answer questions about its content.",
      inputSchema: z.object({
        name: fileNameSchema,
      }),
      execute: ({ name }) =>
        asToolResult(async () => {
          // Agent-written artifacts first, then user uploads (attached files
          // land in the uploads folder but are read by the same tool).
          const content =
            (await readConversationFile(conversationId, name)) ??
            (await readConversationFile(conversationId, name, "upload"));
          if (content === null) return { error: `File "${name}" does not exist` };
          return {
            name,
            content:
              content.length > MAX_READ_CHARS
                ? `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated]`
                : content,
          };
        }),
    }),

    listFiles: tool({
      description: "List the files in this conversation's workspace with their sizes.",
      inputSchema: z.object({}),
      execute: () =>
        asToolResult(async () => {
          const files = await listConversationFiles(conversationId);
          return { files: files.map(({ name, size }) => ({ name, size })) };
        }),
    }),

    presentFile: tool({
      description:
        "Open a file from this conversation's workspace in the user's file viewer panel, rendered by type (markdown formatted, HTML displayed as a page). Use it after writing or updating a file the user should look at, instead of pasting its content into the chat.",
      inputSchema: z.object({
        name: fileNameSchema,
      }),
      // The tool itself only verifies the file exists; the UI watches for this
      // tool call in the message stream and opens the viewer.
      execute: ({ name }) =>
        asToolResult(async () => {
          const file = await statConversationFile(conversationId, name);
          if (!file) return { error: `File "${name}" does not exist` };
          return { presented: name };
        }),
    }),
  };
}

// Marker prefix for the user-message text part that lists files the user
// attached to a turn (e.g. long pasted content). The UI's matching constant
// lives in agent-ui/src/lib/api.ts — keep the two literals in sync.
export const ATTACHED_FILES_MARKER = "<attached-files>";

// Static text: like the rest of the system prompt it must stay byte-identical
// across turns of a conversation (KV-cache reuse, see docs/memory.md).
export const filesPrompt = [
  "## Files",
  "- This conversation has its own private file workspace: create or replace files with writeFile, make targeted changes with editFile, and inspect what exists with listFiles and readFile.",
  "- Save deliverables the user will want to keep or download (documents, code, plans, lists) as files instead of only pasting them into chat, and mention the file name — the user can download files from the Files view.",
  "- After writing or updating a file worth looking at, call presentFile to open it in the viewer next to the chat (markdown is rendered, HTML is displayed as a page). Don't paste the file's content into the chat as well.",
  "- Files the user attaches to a message are listed in an `<attached-files>` block (a JSON array of {name, label}); they are saved in this workspace already — read their content with readFile by name when it is relevant to the request.",
  "- Images the user attaches are part of the message itself — you can see them directly; don't try to readFile them.",
  "- Files persist across turns of this conversation but are not visible from other conversations.",
].join("\n");
