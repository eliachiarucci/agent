import { and, asc, desc, eq, gte, inArray, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../global/db";
import {
  agentMembers,
  deviceEvents,
  deviceObservations,
  devices,
  type DeviceEventKind,
} from "../global/schema";

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type DeviceObservation = typeof deviceObservations.$inferSelect;
export type NewDeviceObservation = typeof deviceObservations.$inferInsert;

export async function createDevice(data: NewDevice): Promise<Device> {
  const [row] = await db.insert(devices).values(data).returning();
  return row;
}

export async function getDevice(id: string): Promise<Device | undefined> {
  return db.query.devices.findFirst({ where: eq(devices.id, id) });
}

export async function getDeviceByTokenHash(tokenHash: string): Promise<Device | undefined> {
  return db.query.devices.findFirst({ where: eq(devices.tokenHash, tokenHash) });
}

export async function listAllDevices(): Promise<Device[]> {
  return db.select().from(devices);
}

/** Devices the user owns, plus those working for an agent the user is a member of. */
export async function listDevicesForUser(userId: string): Promise<Device[]> {
  const memberAgents = db
    .select({ agentId: agentMembers.agentId })
    .from(agentMembers)
    .where(eq(agentMembers.userId, userId));
  return db
    .select()
    .from(devices)
    .where(or(eq(devices.ownerId, userId), inArray(devices.agentId, memberAgents)))
    .orderBy(asc(devices.createdAt));
}

export async function updateDevice(
  id: string,
  changes: Partial<
    Pick<Device, "name" | "agentId" | "settings" | "tokenHash" | "tokenCreatedAt" | "hello" | "telemetry" | "lastSeenAt">
  >
): Promise<Device | undefined> {
  const [row] = await db
    .update(devices)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(devices.id, id))
    .returning();
  return row;
}

/** Link bookkeeping (last seen, hello, telemetry): leaves updatedAt alone, which tracks user edits. */
export async function touchDevice(
  id: string,
  changes: Partial<Pick<Device, "hello" | "telemetry">> = {}
): Promise<void> {
  await db
    .update(devices)
    .set({ ...changes, lastSeenAt: new Date() })
    .where(eq(devices.id, id));
}

export async function deleteDevice(id: string): Promise<Device | undefined> {
  const [row] = await db.delete(devices).where(eq(devices.id, id)).returning();
  return row;
}

export async function insertObservation(data: NewDeviceObservation): Promise<DeviceObservation> {
  const [row] = await db.insert(deviceObservations).values(data).returning();
  return row;
}

export async function getObservation(id: string): Promise<DeviceObservation | undefined> {
  return db.query.deviceObservations.findFirst({ where: eq(deviceObservations.id, id) });
}

/** Newest first. `before` pages backwards by capture time. */
export async function listObservations(query: {
  deviceId: string;
  from?: Date;
  to?: Date;
  before?: Date;
  limit: number;
}): Promise<DeviceObservation[]> {
  return db
    .select()
    .from(deviceObservations)
    .where(
      and(
        eq(deviceObservations.deviceId, query.deviceId),
        query.from && gte(deviceObservations.capturedAt, query.from),
        query.to && lte(deviceObservations.capturedAt, query.to),
        query.before && lt(deviceObservations.capturedAt, query.before)
      )
    )
    .orderBy(desc(deviceObservations.capturedAt), desc(deviceObservations.id))
    .limit(query.limit);
}

export async function latestObservation(deviceId: string): Promise<DeviceObservation | undefined> {
  const [row] = await listObservations({ deviceId, limit: 1 });
  return row;
}

/** Observations received before `cutoff` that still have a frame on disk, oldest first. */
export async function findExpiredFrames(
  deviceId: string,
  cutoff: Date,
  limit: number
): Promise<Array<{ id: string; frame: string }>> {
  const rows = await db
    .select({ id: deviceObservations.id, frame: deviceObservations.frame })
    .from(deviceObservations)
    .where(
      and(
        eq(deviceObservations.deviceId, deviceId),
        lt(deviceObservations.receivedAt, cutoff),
        isNotNull(deviceObservations.frame)
      )
    )
    .orderBy(asc(deviceObservations.receivedAt))
    .limit(limit);
  return rows as Array<{ id: string; frame: string }>;
}

export async function clearFrames(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.update(deviceObservations).set({ frame: null }).where(inArray(deviceObservations.id, ids));
}

export async function deleteObservationsBefore(deviceId: string, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(deviceObservations)
    .where(and(eq(deviceObservations.deviceId, deviceId), lt(deviceObservations.receivedAt, cutoff)))
    .returning({ id: deviceObservations.id });
  return rows.length;
}

export async function insertDeviceEvent(
  deviceId: string,
  kind: DeviceEventKind,
  detail?: Record<string, unknown>
): Promise<void> {
  await db.insert(deviceEvents).values({ deviceId, kind, detail });
}

export async function deleteDeviceEventsBefore(deviceId: string, cutoff: Date): Promise<number> {
  const rows = await db
    .delete(deviceEvents)
    .where(and(eq(deviceEvents.deviceId, deviceId), lt(deviceEvents.createdAt, cutoff)))
    .returning({ id: deviceEvents.id });
  return rows.length;
}

export async function countObservations(deviceId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceObservations)
    .where(eq(deviceObservations.deviceId, deviceId));
  return row.n;
}
