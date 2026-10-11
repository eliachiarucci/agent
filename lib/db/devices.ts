import { and, asc, desc, eq, getTableColumns, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "../global/db";
import {
  agentMembers,
  deviceEvents,
  deviceObservations,
  devices,
  type CaptionStatus,
  type DeviceEventKind,
} from "../global/schema";

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
export type NewDeviceObservation = typeof deviceObservations.$inferInsert;
export type DeviceEvent = typeof deviceEvents.$inferSelect;

// Observations are read without their embedding (1.5 KB each, only search needs it).
const { embedding: _embedding, ...observationColumns } = getTableColumns(deviceObservations);
export type DeviceObservation = Omit<typeof deviceObservations.$inferSelect, "embedding">;

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
  const [row] = await db.insert(deviceObservations).values(data).returning(observationColumns);
  return row;
}

export async function getObservation(id: string): Promise<DeviceObservation | undefined> {
  const [row] = await db
    .select(observationColumns)
    .from(deviceObservations)
    .where(eq(deviceObservations.id, id));
  return row;
}

export type ObservationQuery = {
  deviceId: string;
  from?: Date;
  to?: Date;
  before?: Date;
  minSalience?: number;
  // Only frames with a caption.
  captioned?: boolean;
  limit: number;
};

const observationFilter = (query: ObservationQuery) =>
  and(
    eq(deviceObservations.deviceId, query.deviceId),
    query.from && gte(deviceObservations.capturedAt, query.from),
    query.to && lte(deviceObservations.capturedAt, query.to),
    query.before && lt(deviceObservations.capturedAt, query.before),
    query.minSalience !== undefined ? gte(deviceObservations.salience, query.minSalience) : undefined,
    query.captioned ? eq(deviceObservations.captionStatus, "captioned") : undefined
  );

/** Newest first. `before` pages backwards by capture time. */
export async function listObservations(query: ObservationQuery): Promise<DeviceObservation[]> {
  return db
    .select(observationColumns)
    .from(deviceObservations)
    .where(observationFilter(query))
    .orderBy(desc(deviceObservations.capturedAt), desc(deviceObservations.id))
    .limit(query.limit);
}

/** Captioned observations closest in meaning to the query vector, best first. */
export async function searchObservations(
  query: ObservationQuery & { vector: number[] }
): Promise<Array<DeviceObservation & { relevance: number }>> {
  const distance = sql<number>`${deviceObservations.embedding} <=> ${JSON.stringify(query.vector)}::halfvec`;
  const rows = await db
    .select({ ...observationColumns, distance })
    .from(deviceObservations)
    .where(and(observationFilter(query), isNotNull(deviceObservations.embedding)))
    .orderBy(distance)
    .limit(query.limit);
  return rows.map(({ distance, ...row }) => ({ ...row, relevance: 1 - Number(distance) }));
}

export async function latestObservation(deviceId: string): Promise<DeviceObservation | undefined> {
  const [row] = await listObservations({ deviceId, limit: 1 });
  return row;
}

export async function latestCaptioned(deviceId: string): Promise<DeviceObservation | undefined> {
  const [row] = await db
    .select(observationColumns)
    .from(deviceObservations)
    .where(and(eq(deviceObservations.deviceId, deviceId), eq(deviceObservations.captionStatus, "captioned")))
    .orderBy(desc(deviceObservations.captionedAt))
    .limit(1);
  return row;
}

export async function updateCaption(
  id: string,
  changes: Pick<NewDeviceObservation, "captionStatus"> &
    Partial<Pick<NewDeviceObservation, "caption" | "captionMeta" | "captionedAt" | "salience" | "embedding">>
): Promise<DeviceObservation | undefined> {
  const [row] = await db
    .update(deviceObservations)
    .set(changes)
    .where(eq(deviceObservations.id, id))
    .returning(observationColumns);
  return row;
}

/** Sets a final status on a frame that is still waiting (status NULL). */
export async function settleWaitingCaption(id: string, status: CaptionStatus): Promise<void> {
  await db
    .update(deviceObservations)
    .set({ captionStatus: status })
    .where(and(eq(deviceObservations.id, id), isNull(deviceObservations.captionStatus)));
}

/** Model calls (captioned or failed) since `since`: what the hourly budget counts. */
export async function countCaptionCalls(deviceId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceObservations)
    .where(
      and(
        eq(deviceObservations.deviceId, deviceId),
        gte(deviceObservations.captionedAt, since),
        inArray(deviceObservations.captionStatus, ["captioned", "failed"])
      )
    );
  return row.n;
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
): Promise<DeviceEvent> {
  const [row] = await db.insert(deviceEvents).values({ deviceId, kind, detail }).returning();
  return row;
}

/** Newest first. */
export async function listDeviceEvents(query: {
  deviceId: string;
  kind: DeviceEventKind;
  since?: Date;
  limit: number;
}): Promise<DeviceEvent[]> {
  return db
    .select()
    .from(deviceEvents)
    .where(
      and(
        eq(deviceEvents.deviceId, query.deviceId),
        eq(deviceEvents.kind, query.kind),
        query.since && gte(deviceEvents.createdAt, query.since)
      )
    )
    .orderBy(desc(deviceEvents.createdAt), desc(deviceEvents.id))
    .limit(query.limit);
}

/** Events of a kind since `since` whose detail.status is one of `statuses`. */
export async function countDeviceEvents(
  deviceId: string,
  kind: DeviceEventKind,
  since: Date,
  statuses: string[]
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceEvents)
    .where(
      and(
        eq(deviceEvents.deviceId, deviceId),
        eq(deviceEvents.kind, kind),
        gte(deviceEvents.createdAt, since),
        inArray(sql<string>`${deviceEvents.detail}->>'status'`, statuses)
      )
    );
  return row.n;
}

/** Captions since `since` that the model marked worth logging (wake "log" or "agent"). */
export async function countNotableSince(deviceId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(deviceObservations)
    .where(
      and(
        eq(deviceObservations.deviceId, deviceId),
        eq(deviceObservations.captionStatus, "captioned"),
        gte(deviceObservations.capturedAt, since),
        inArray(sql<string>`${deviceObservations.caption}->>'wake'`, ["log", "agent"])
      )
    );
  return row.n;
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
