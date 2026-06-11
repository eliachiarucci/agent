import { tool } from "ai";
import { z } from "zod";
import {
  deleteNoteByTitle,
  getNoteByTitle,
  listNotes,
  upsertNote,
  type Note,
} from "../db/notes";

// Notes are agent-wide living documents (lists, plans, reference info): unlike
// conversation files they are shared across every conversation of the agent,
// and unlike memories they are full documents the user can also edit by hand
// in the Notes view. Tools address them by title — the stable handle a model
// keeps straight far better than a UUID.

const MAX_NOTE_CHARS = 100_000;
const MAX_NOTES_PER_AGENT = 200;
// Keeps readNote tool results within local-model-friendly context budgets.
const MAX_READ_CHARS = 20_000;

// A short single-line handle; it doubles as the unique key within the agent.
export function isValidNoteTitle(title: string): boolean {
  const hasControlChar = [...title].some((char) => char.charCodeAt(0) < 0x20);
  return title.length > 0 && title.length <= 200 && !hasControlChar && title === title.trim();
}

export async function writeNote(
  agentId: string,
  createdBy: string,
  title: string,
  content: string
): Promise<Note> {
  if (!isValidNoteTitle(title)) {
    throw new Error(
      `Invalid note title ${JSON.stringify(title)}: use a short single-line title (max 200 characters)`
    );
  }
  if (content.length > MAX_NOTE_CHARS) {
    throw new Error(
      `Note too large (${content.length} characters); the limit is ${MAX_NOTE_CHARS} characters`
    );
  }
  const existing = await listNotes(agentId);
  if (existing.length >= MAX_NOTES_PER_AGENT && !existing.some((note) => note.title === title)) {
    throw new Error(
      `This agent already has ${MAX_NOTES_PER_AGENT} notes; update or remove an existing one`
    );
  }
  return upsertNote({ agentId, createdBy, title, content });
}

/** Replaces every occurrence of `oldText`; throws when the note or the text is missing. */
export async function editNote(
  agentId: string,
  createdBy: string,
  title: string,
  oldText: string,
  newText: string
): Promise<{ replacements: number }> {
  const note = await getNoteByTitle(agentId, title);
  if (!note) {
    throw new Error(`Note "${title}" does not exist; create it with writeNote first`);
  }
  const parts = note.content.split(oldText);
  if (parts.length === 1) {
    throw new Error(
      `old_text was not found in "${title}"; read the note and retry with an exact snippet`
    );
  }
  await writeNote(agentId, createdBy, title, parts.join(newText));
  return { replacements: parts.length - 1 };
}

const noteTitleSchema = z
  .string()
  .refine(isValidNoteTitle, "Short single-line note title")
  .describe('The note\'s title, e.g. "Grocery list". Titles are unique within this assistant.');

// Failures come back as values ({ error }) instead of throwing, so the model
// can read what went wrong and correct itself (same pattern as the file tools).
async function asToolResult<T extends object>(
  action: () => Promise<T>
): Promise<T | { error: string }> {
  try {
    return await action();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Note operation failed" };
  }
}

// Built per request: the closure pins every operation to the current agent's
// notes and attributes writes to the current speaker. Schemas are static, so
// the prompt prefix stays KV-cache friendly (see docs/memory.md).
export function buildNoteTools(agentId: string, userId: string) {
  return {
    listNotes: tool({
      description:
        "List this assistant's shared notes by title. Notes are visible from every conversation; check here before assuming a note does or doesn't exist.",
      inputSchema: z.object({}),
      execute: () =>
        asToolResult(async () => {
          const notes = await listNotes(agentId);
          return {
            notes: notes.map((note) => ({
              title: note.title,
              updatedAt: note.updatedAt.toISOString().slice(0, 10),
            })),
          };
        }),
    }),

    readNote: tool({
      description:
        "Read a shared note's content, e.g. before answering questions about it or editing it.",
      inputSchema: z.object({
        title: noteTitleSchema,
      }),
      execute: ({ title }) =>
        asToolResult(async () => {
          const note = await getNoteByTitle(agentId, title);
          if (!note) return { error: `Note "${title}" does not exist` };
          return {
            title: note.title,
            content:
              note.content.length > MAX_READ_CHARS
                ? `${note.content.slice(0, MAX_READ_CHARS)}\n\n[truncated]`
                : note.content,
          };
        }),
    }),

    writeNote: tool({
      description:
        "Create a shared note, or replace the content of an existing one. Use notes for living documents the user wants to keep across conversations (running lists, plans, reference info).",
      inputSchema: z.object({
        title: noteTitleSchema,
        content: z
          .string()
          .describe(
            "The complete note content in Markdown; it replaces whatever the note contained before."
          ),
      }),
      execute: ({ title, content }) =>
        asToolResult(async () => {
          const note = await writeNote(agentId, userId, title, content);
          return { title: note.title };
        }),
    }),

    editNote: tool({
      description:
        "Modify an existing note by replacing an exact text snippet. Prefer this over writeNote for small changes (adding a list item, fixing a value), so the rest of the note is preserved untouched.",
      inputSchema: z.object({
        title: noteTitleSchema,
        old_text: z
          .string()
          .min(1)
          .describe("Exact text currently in the note; every occurrence is replaced."),
        new_text: z.string().describe("The replacement text."),
      }),
      execute: ({ title, old_text, new_text }) =>
        asToolResult(() => editNote(agentId, userId, title, old_text, new_text)),
    }),

    deleteNote: tool({
      description: "Permanently delete a shared note the user no longer wants.",
      inputSchema: z.object({
        title: noteTitleSchema,
      }),
      execute: ({ title }) =>
        asToolResult(async () => {
          const note = await deleteNoteByTitle(agentId, title);
          if (!note) return { error: `Note "${title}" does not exist` };
          return { deleted: note.title };
        }),
    }),
  };
}

// Static text: like the rest of the system prompt it must stay byte-identical
// across turns of a conversation (KV-cache reuse, see docs/memory.md).
export const notesPrompt = [
  "## Notes",
  "- This assistant has shared notes: living Markdown documents (running lists, plans, reference info) that persist across all conversations and that the user can also read and edit by hand in the Notes view. Write note content in Markdown.",
  "- Use writeNote to start a note, editNote for targeted changes, and readNote before relying on or modifying one — the user may have edited it since you last saw it. listNotes shows what exists.",
  "- Prefer a note over a conversation file when the user will want the content from other conversations (e.g. a shopping list they keep adding to); prefer memories for individual facts rather than documents.",
  "- Refer to notes by their title, and delete one with deleteNote only when the user asks.",
].join("\n");
