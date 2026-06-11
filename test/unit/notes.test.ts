import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createNote,
  deleteNote,
  deleteNoteByTitle,
  getNote,
  getNoteByTitle,
  listNotes,
  updateNote,
  upsertNote,
} from "../../lib/db/notes";
import { editNote, isValidNoteTitle, writeNote } from "../../lib/agent/notes";
import { closeDb, makeUserWithAgent, resetDb } from "../helpers/db";

beforeEach(resetDb);
afterAll(closeDb);

describe("note titles", () => {
  it("accepts plain single-line titles and rejects junk", () => {
    expect(isValidNoteTitle("Grocery list")).toBe(true);
    expect(isValidNoteTitle("Plans for 2026 ✈️")).toBe(true);
    expect(isValidNoteTitle("")).toBe(false);
    expect(isValidNoteTitle(" padded ")).toBe(false);
    expect(isValidNoteTitle("two\nlines")).toBe(false);
    expect(isValidNoteTitle("a".repeat(201))).toBe(false);
  });
});

describe("notes db", () => {
  it("creates, reads, updates and deletes a note within its agent", async () => {
    const { user, agent } = await makeUserWithAgent("Alice");

    const note = await createNote({
      agentId: agent.id,
      createdBy: user.id,
      title: "Grocery list",
      content: "- milk",
    });
    expect(await getNote(agent.id, note.id)).toMatchObject({ title: "Grocery list" });
    expect(await getNoteByTitle(agent.id, "Grocery list")).toMatchObject({ id: note.id });

    const updated = await updateNote(agent.id, note.id, { content: "- milk\n- eggs" });
    expect(updated?.content).toBe("- milk\n- eggs");
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(note.updatedAt.getTime());

    expect(await deleteNote(agent.id, note.id)).toMatchObject({ id: note.id });
    expect(await getNote(agent.id, note.id)).toBeUndefined();
  });

  it("never reads or touches notes across agents", async () => {
    const { user: alice, agent: aliceAgent } = await makeUserWithAgent("Alice");
    const { agent: bobAgent } = await makeUserWithAgent("Bob");

    const note = await createNote({
      agentId: aliceAgent.id,
      createdBy: alice.id,
      title: "Secret plan",
      content: "shh",
    });

    expect(await getNote(bobAgent.id, note.id)).toBeUndefined();
    expect(await getNoteByTitle(bobAgent.id, "Secret plan")).toBeUndefined();
    expect(await updateNote(bobAgent.id, note.id, { content: "hijacked" })).toBeUndefined();
    expect(await deleteNote(bobAgent.id, note.id)).toBeUndefined();
    expect(await listNotes(bobAgent.id)).toEqual([]);
    // Same title in another agent is a separate note, not a conflict.
    await createNote({ agentId: bobAgent.id, title: "Secret plan", content: "different" });
    expect((await getNoteByTitle(aliceAgent.id, "Secret plan"))?.content).toBe("shh");
  });

  it("upserts by title: same title replaces the content, keeping the row", async () => {
    const { user, agent } = await makeUserWithAgent("Alice");

    const first = await upsertNote({
      agentId: agent.id,
      createdBy: user.id,
      title: "Grocery list",
      content: "- milk",
    });
    const second = await upsertNote({
      agentId: agent.id,
      createdBy: user.id,
      title: "Grocery list",
      content: "- eggs",
    });

    expect(second.id).toBe(first.id);
    expect(second.content).toBe("- eggs");
    expect(await listNotes(agent.id)).toHaveLength(1);
  });
});

describe("note tool helpers", () => {
  it("writeNote validates the title and editNote replaces every occurrence", async () => {
    const { user, agent } = await makeUserWithAgent("Alice");

    await expect(writeNote(agent.id, user.id, "bad\ntitle", "x")).rejects.toThrow(/title/);

    await writeNote(agent.id, user.id, "Grocery list", "- milk\n- milk");
    const result = await editNote(agent.id, user.id, "Grocery list", "milk", "eggs");
    expect(result.replacements).toBe(2);
    expect((await getNoteByTitle(agent.id, "Grocery list"))?.content).toBe("- eggs\n- eggs");
  });

  it("editNote reports a missing note or snippet instead of writing", async () => {
    const { user, agent } = await makeUserWithAgent("Alice");

    await expect(editNote(agent.id, user.id, "Nope", "a", "b")).rejects.toThrow(/does not exist/);

    await writeNote(agent.id, user.id, "Plan", "step one");
    await expect(editNote(agent.id, user.id, "Plan", "step two", "x")).rejects.toThrow(
      /not found/
    );
    expect((await getNoteByTitle(agent.id, "Plan"))?.content).toBe("step one");
  });

  it("deleteNoteByTitle removes exactly the named note", async () => {
    const { user, agent } = await makeUserWithAgent("Alice");
    await writeNote(agent.id, user.id, "Keep", "a");
    await writeNote(agent.id, user.id, "Drop", "b");

    expect(await deleteNoteByTitle(agent.id, "Drop")).toMatchObject({ title: "Drop" });
    expect((await listNotes(agent.id)).map((n) => n.title)).toEqual(["Keep"]);
  });
});
