import type express from "express";
import { getSessionUser, type SessionUser } from "../agent/actor";
import { isAgentMember } from "../db/agents";
import { getDevice, type Device } from "../db/devices";
import { deviceLinkStatus } from "./gateway";
import { readDeviceSettings } from "./settings";

// Who may see a device: its owner, and the members of the agent it works for.
// Only the owner may change it (settings, token, delete).

export type DeviceRole = "owner" | "member";

export type DeviceAccess =
  | { ok: true; user: SessionUser; device: Device; role: DeviceRole }
  | { ok: false; status: number; error: string };

export async function deviceRole(device: Device, userId: string): Promise<DeviceRole | null> {
  if (device.ownerId === userId) return "owner";
  if (device.agentId && (await isAgentMember(device.agentId, userId))) return "member";
  return null;
}

export async function resolveDeviceAccess(
  req: express.Request,
  deviceId: string,
  options: { owner?: boolean } = {}
): Promise<DeviceAccess> {
  const user = await getSessionUser(req);
  if (!user) return { ok: false, status: 401, error: "Not authenticated" };

  const device = await getDevice(deviceId);
  const role = device ? await deviceRole(device, user.id) : null;
  // Invisible devices are "not found", so ids can't be probed.
  if (!device || !role) return { ok: false, status: 404, error: "Device not found" };
  if (options.owner && role !== "owner") {
    return { ok: false, status: 403, error: "Only the device's owner can change it" };
  }
  return { ok: true, user, device, role };
}

/** The API shape of a device: never the token hash. */
export function publicDevice(device: Device, role: DeviceRole) {
  const { tokenHash: _tokenHash, pairingCodeHash: _pairingCodeHash, settings, ...rest } = device;
  return { ...rest, settings: readDeviceSettings(settings), role, ...deviceLinkStatus(device.id) };
}
