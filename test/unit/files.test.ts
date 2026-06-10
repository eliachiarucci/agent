import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// FILES_DIR is read lazily on every storage call, so pointing it at a temp dir
// in beforeAll is enough — no module-load ordering games.
import {
  buildFileTools,
  editConversationFile,
  isValidFileName,
  listConversationFiles,
  readConversationFile,
  removeConversationFiles,
  statConversationFile,
  writeConversationFile,
} from "../../lib/agent/files";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-files-"));
  process.env.FILES_DIR = root;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const conversationId = () => crypto.randomUUID();

describe("isValidFileName", () => {
  it("accepts plain names with extensions", () => {
    expect(isValidFileName("notes.md")).toBe(true);
    expect(isValidFileName("Trip Plan 2026.txt")).toBe(true);
    expect(isValidFileName(".gitignore")).toBe(true);
  });

  it("rejects paths, traversal, and junk", () => {
    expect(isValidFileName("")).toBe(false);
    expect(isValidFileName(".")).toBe(false);
    expect(isValidFileName("..")).toBe(false);
    expect(isValidFileName("../escape.txt")).toBe(false);
    expect(isValidFileName("a/b.txt")).toBe(false);
    expect(isValidFileName("a\\b.txt")).toBe(false);
    expect(isValidFileName(" padded.txt")).toBe(false);
    expect(isValidFileName("line\nbreak.txt")).toBe(false);
    expect(isValidFileName("x".repeat(129))).toBe(false);
  });
});

describe("conversation file storage", () => {
  it("writes, lists, and reads a file back", async () => {
    const id = conversationId();
    const written = await writeConversationFile(id, "notes.md", "# Hello");
    expect(written.size).toBe(Buffer.byteLength("# Hello"));

    expect(await readConversationFile(id, "notes.md")).toBe("# Hello");

    const files = await listConversationFiles(id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: "notes.md", size: written.size });
    expect(files[0].updatedAt).toBeInstanceOf(Date);
  });

  it("overwrites on a second write to the same name", async () => {
    const id = conversationId();
    await writeConversationFile(id, "a.txt", "first");
    await writeConversationFile(id, "a.txt", "second");
    expect(await readConversationFile(id, "a.txt")).toBe("second");
    expect(await listConversationFiles(id)).toHaveLength(1);
  });

  it("keeps conversations isolated from each other", async () => {
    const a = conversationId();
    const b = conversationId();
    await writeConversationFile(a, "only-in-a.txt", "a");
    expect(await listConversationFiles(b)).toEqual([]);
    expect(await readConversationFile(b, "only-in-a.txt")).toBeNull();
  });

  it("rejects invalid names and oversized content", async () => {
    const id = conversationId();
    await expect(writeConversationFile(id, "../escape.txt", "x")).rejects.toThrow(
      /invalid file name/i
    );
    await expect(readConversationFile(id, "a/b.txt")).rejects.toThrow(/invalid file name/i);
    await expect(
      writeConversationFile(id, "big.txt", "x".repeat(1024 * 1024 + 1))
    ).rejects.toThrow(/too large/i);
  });

  it("edits by replacing every occurrence of the exact snippet", async () => {
    const id = conversationId();
    await writeConversationFile(id, "list.md", "- apple\n- apple\n- pear");

    const result = await editConversationFile(id, "list.md", "apple", "plum");
    expect(result.replacements).toBe(2);
    expect(await readConversationFile(id, "list.md")).toBe("- plum\n- plum\n- pear");

    await expect(editConversationFile(id, "list.md", "banana", "x")).rejects.toThrow(
      /not found/i
    );
    await expect(editConversationFile(id, "missing.md", "a", "b")).rejects.toThrow(
      /does not exist/i
    );
  });

  it("stats a single file, null when missing", async () => {
    const id = conversationId();
    await writeConversationFile(id, "a.txt", "abc");

    const file = await statConversationFile(id, "a.txt");
    expect(file).toMatchObject({ name: "a.txt", size: 3 });
    expect(file?.updatedAt).toBeInstanceOf(Date);

    expect(await statConversationFile(id, "missing.txt")).toBeNull();
  });

  it("presentFile succeeds only for files that exist", async () => {
    const id = conversationId();
    await writeConversationFile(id, "report.md", "# Report");
    const { presentFile } = buildFileTools(id);
    const callOptions = { toolCallId: "test", messages: [] };

    expect(await presentFile.execute!({ name: "report.md" }, callOptions)).toEqual({
      presented: "report.md",
    });
    expect(await presentFile.execute!({ name: "missing.md" }, callOptions)).toEqual({
      error: 'File "missing.md" does not exist',
    });
  });

  it("removes the whole folder, and tolerates a folder that never existed", async () => {
    const id = conversationId();
    await writeConversationFile(id, "a.txt", "a");
    await writeConversationFile(id, "b.txt", "b");

    await removeConversationFiles(id);
    expect(await listConversationFiles(id)).toEqual([]);

    await expect(removeConversationFiles(conversationId())).resolves.toBeUndefined();
  });
});
