import { tool } from "ai";
import { z } from "zod";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Conversation artifacts are plain files on disk, one folder per conversation
// (FILES_DIR/<conversation id>/<name>), so each conversation maps to exactly
// one folder. Nothing is duplicated into Postgres: visibility derives from the
// conversation the folder belongs to (whoever can read the conversation can
// read its files), and the folder is removed together with the conversation.
const filesRoot = () => resolve(process.env.FILES_DIR ?? "data/files");

// Bounds chosen for text artifacts written by a model, not user uploads.
const MAX_FILE_BYTES = 1024 * 1024;
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

export function conversationFilePath(conversationId: string, name: string): string {
  if (!isValidFileName(name)) {
    throw new Error(
      `Invalid file name ${JSON.stringify(name)}: use a plain name with extension, without slashes`
    );
  }
  return join(filesRoot(), conversationId, name);
}

export type ConversationFile = { name: string; size: number; updatedAt: Date };

export async function listConversationFiles(conversationId: string): Promise<ConversationFile[]> {
  const dir = join(filesRoot(), conversationId);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const stats = await stat(join(dir, entry.name));
        return { name: entry.name, size: stats.size, updatedAt: stats.mtime };
      })
  );
  return files.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function statConversationFile(
  conversationId: string,
  name: string
): Promise<ConversationFile | null> {
  try {
    const stats = await stat(conversationFilePath(conversationId, name));
    if (!stats.isFile()) return null;
    return { name, size: stats.size, updatedAt: stats.mtime };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function readConversationFile(
  conversationId: string,
  name: string
): Promise<string | null> {
  try {
    return await readFile(conversationFilePath(conversationId, name), "utf8");
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function writeConversationFile(
  conversationId: string,
  name: string,
  content: string
): Promise<ConversationFile> {
  const path = conversationFilePath(conversationId, name);
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) {
    throw new Error(`File too large (${size} bytes); the limit is ${MAX_FILE_BYTES} bytes`);
  }
  const existing = await listConversationFiles(conversationId);
  if (
    existing.length >= MAX_FILES_PER_CONVERSATION &&
    !existing.some((file) => file.name === name)
  ) {
    throw new Error(
      `This conversation already has ${MAX_FILES_PER_CONVERSATION} files; update or reuse an existing one`
    );
  }
  await mkdir(join(filesRoot(), conversationId), { recursive: true });
  await writeFile(path, content, "utf8");
  return { name, size, updatedAt: new Date() };
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
          const content = await readConversationFile(conversationId, name);
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

// Static text: like the rest of the system prompt it must stay byte-identical
// across turns of a conversation (KV-cache reuse, see docs/memory.md).
export const filesPrompt = [
  "## Files",
  "- This conversation has its own private file workspace: create or replace files with writeFile, make targeted changes with editFile, and inspect what exists with listFiles and readFile.",
  "- Save deliverables the user will want to keep or download (documents, code, plans, lists) as files instead of only pasting them into chat, and mention the file name — the user can download files from the Files view.",
  "- After writing or updating a file worth looking at, call presentFile to open it in the viewer next to the chat (markdown is rendered, HTML is displayed as a page). Don't paste the file's content into the chat as well.",
  "- Files persist across turns of this conversation but are not visible from other conversations.",
].join("\n");
