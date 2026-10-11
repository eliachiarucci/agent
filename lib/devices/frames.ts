import { randomUUID } from "node:crypto";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { filesRoot } from "../agent/files";

// Device frames are JPEG files under FILES_DIR/devices/<device id>/frames/, next
// to the conversation folders (whose names are UUIDs, so "devices" never
// collides). Deployments already mount FILES_DIR as a volume. The DB row
// (device_observations.frame) holds the file name.

// Above the largest frame the rover sends: a full 3280×2464 still at q95 is
// about 2–3 MB.
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_SIDE = 4096;

export class InvalidFrameError extends Error {}

const deviceDir = (deviceId: string) => join(filesRoot(), "devices", deviceId);

export function frameFilePath(deviceId: string, frame: string): string {
  // Names are generated here (UUID.jpg); refuse anything else so a bad row can
  // never point outside the folder.
  if (!/^[0-9a-f-]{36}\.jpg$/.test(frame)) throw new Error(`Invalid frame name ${frame}`);
  return join(deviceDir(deviceId), "frames", frame);
}

/** Checks that the bytes are a JPEG of a sane size and returns its dimensions. */
export async function inspectJpeg(bytes: Buffer): Promise<{ width: number; height: number }> {
  if (bytes.length === 0) throw new InvalidFrameError("Empty frame");
  if (bytes.length > MAX_FRAME_BYTES) throw new InvalidFrameError("Frame too large");
  // SOI marker; sharp would also sniff other formats, which we don't accept.
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new InvalidFrameError("Not a JPEG");
  }
  let meta: sharp.Metadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new InvalidFrameError("Unreadable JPEG");
  }
  const { format, width, height } = meta;
  if (format !== "jpeg" || !width || !height) throw new InvalidFrameError("Unreadable JPEG");
  if (width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE) {
    throw new InvalidFrameError(`Frame too large (${width}x${height})`);
  }
  return { width, height };
}

/** Stores the JPEG and returns its file name. */
export async function writeFrame(deviceId: string, bytes: Buffer): Promise<string> {
  const frame = `${randomUUID()}.jpg`;
  const path = frameFilePath(deviceId, frame);
  await mkdir(join(deviceDir(deviceId), "frames"), { recursive: true });
  await writeFile(path, bytes);
  return frame;
}

export async function removeFrame(deviceId: string, frame: string): Promise<void> {
  try {
    await unlink(frameFilePath(deviceId, frame));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeDeviceFiles(deviceId: string): Promise<void> {
  await rm(deviceDir(deviceId), { recursive: true, force: true });
}
