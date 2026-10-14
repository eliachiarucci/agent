import { and, asc, eq, lte, ne, sql } from "drizzle-orm";
import { db } from "../global/db";
import { deviceTriggers } from "../global/schema";

// Queries for device triggers (plan 4.12); the rules are in lib/devices/triggers.ts.

export type DeviceTrigger = typeof deviceTriggers.$inferSelect;
export type NewDeviceTrigger = typeof deviceTriggers.$inferInsert;

export async function createDeviceTrigger(data: NewDeviceTrigger): Promise<DeviceTrigger> {
  const [row] = await db.insert(deviceTriggers).values(data).returning();
  return row;
}

/** A device's triggers for its agent, the soonest first (reminders by time, watches by expiry). */
export async function listDeviceTriggers(deviceId: string, agentId: string): Promise<DeviceTrigger[]> {
  return db
    .select()
    .from(deviceTriggers)
    .where(and(eq(deviceTriggers.deviceId, deviceId), eq(deviceTriggers.agentId, agentId)))
    .orderBy(asc(sql`coalesce(${deviceTriggers.at}, ${deviceTriggers.expiresAt})`), asc(deviceTriggers.createdAt));
}

/** Removes a trigger; returns it if it was there (so only one caller fires or cancels it). */
export async function deleteDeviceTrigger(id: string): Promise<DeviceTrigger | undefined> {
  const [row] = await db.delete(deviceTriggers).where(eq(deviceTriggers.id, id)).returning();
  return row;
}

/** Removes a device's triggers set by an agent it no longer works for. */
export async function deleteOtherAgentsTriggers(deviceId: string, agentId: string | null): Promise<DeviceTrigger[]> {
  return db
    .delete(deviceTriggers)
    .where(
      agentId
        ? and(eq(deviceTriggers.deviceId, deviceId), ne(deviceTriggers.agentId, agentId))
        : eq(deviceTriggers.deviceId, deviceId)
    )
    .returning();
}

/** Reminders whose time has come, on every device. */
export async function listDueReminders(now: Date): Promise<DeviceTrigger[]> {
  return db
    .select()
    .from(deviceTriggers)
    .where(and(eq(deviceTriggers.kind, "at"), lte(deviceTriggers.at, now)))
    .orderBy(asc(deviceTriggers.at));
}

/** Removes and returns the triggers past their expiry, on every device. */
export async function deleteExpiredTriggers(now: Date): Promise<DeviceTrigger[]> {
  return db.delete(deviceTriggers).where(lte(deviceTriggers.expiresAt, now)).returning();
}

/** A repeating watch fired: disarmed until the thing is out of view. Returns false if another caller got there first. */
export async function markWatchFired(id: string, now: Date): Promise<boolean> {
  const rows = await db
    .update(deviceTriggers)
    .set({ armed: false, lastFiredAt: now, fired: sql`${deviceTriggers.fired} + 1` })
    .where(and(eq(deviceTriggers.id, id), eq(deviceTriggers.armed, true)))
    .returning({ id: deviceTriggers.id });
  return rows.length > 0;
}

/** A repeating watch's thing is out of view: it may fire again. */
export async function rearmWatch(id: string): Promise<void> {
  await db.update(deviceTriggers).set({ armed: true }).where(eq(deviceTriggers.id, id));
}
