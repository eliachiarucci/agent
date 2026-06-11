import { and, desc, eq } from "drizzle-orm";
import { db } from "../global/db";
import { notes } from "../global/schema";

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

// Notes are agent-scoped, not per user: every query takes the agentId so a
// note can never be read or touched from outside its agent.

export async function listNotes(agentId: string): Promise<Note[]> {
  return db.query.notes.findMany({
    where: eq(notes.agentId, agentId),
    orderBy: desc(notes.updatedAt),
  });
}

export async function getNote(agentId: string, id: string): Promise<Note | undefined> {
  return db.query.notes.findFirst({ where: and(eq(notes.agentId, agentId), eq(notes.id, id)) });
}

export async function getNoteByTitle(agentId: string, title: string): Promise<Note | undefined> {
  return db.query.notes.findFirst({
    where: and(eq(notes.agentId, agentId), eq(notes.title, title)),
  });
}

export async function createNote(data: NewNote): Promise<Note> {
  const [row] = await db.insert(notes).values(data).returning();
  return row;
}

/** Create-or-replace by title — what the agent's writeNote tool does. */
export async function upsertNote(data: NewNote): Promise<Note> {
  const [row] = await db
    .insert(notes)
    .values(data)
    .onConflictDoUpdate({
      target: [notes.agentId, notes.title],
      set: { content: data.content, updatedAt: new Date() },
    })
    .returning();
  return row;
}

export async function updateNote(
  agentId: string,
  id: string,
  changes: Partial<Pick<Note, "title" | "content">>
): Promise<Note | undefined> {
  const [row] = await db
    .update(notes)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(notes.agentId, agentId), eq(notes.id, id)))
    .returning();
  return row;
}

export async function deleteNote(agentId: string, id: string): Promise<Note | undefined> {
  const [row] = await db
    .delete(notes)
    .where(and(eq(notes.agentId, agentId), eq(notes.id, id)))
    .returning();
  return row;
}

export async function deleteNoteByTitle(agentId: string, title: string): Promise<Note | undefined> {
  const [row] = await db
    .delete(notes)
    .where(and(eq(notes.agentId, agentId), eq(notes.title, title)))
    .returning();
  return row;
}
