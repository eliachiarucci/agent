import { asc, eq } from "drizzle-orm";
import { db } from "../global/db";
import { users } from "../global/schema";

export type User = typeof users.$inferSelect;

// Users are created through Better Auth (signup); this module only reads them.

export async function getUser(id: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, id) });
}

export async function listUsers(): Promise<User[]> {
  return db.query.users.findMany({ orderBy: asc(users.createdAt) });
}
