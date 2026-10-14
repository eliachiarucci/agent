import { createHash, randomBytes, randomInt } from "node:crypto";

// Device tokens: 32 random bytes, base64url, with a prefix so a leaked token is
// recognisable. Only the SHA-256 is stored (devices.token_hash); a fast hash is
// enough because the token is random, not a password.
const PREFIX = "dev_";

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateDeviceToken(): { token: string; hash: string } {
  const token = PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashDeviceToken(token) };
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header?.trim() ?? "");
  return match ? match[1] : null;
}

// Pairing codes: 10 characters from an alphabet without look-alikes (no 0/O,
// 1/I/L), shown as XXXXX-XXXXX; about 50 bits, one use, short-lived. Typed on
// the device, so case, spaces and dashes don't matter.
const PAIRING_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const PAIRING_LENGTH = 10;
export const PAIRING_TTL_MS = 30 * 60 * 1000;

export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function hashPairingCode(code: string): string {
  return createHash("sha256").update(normalizePairingCode(code), "utf8").digest("hex");
}

export function generatePairingCode(now = new Date()): { code: string; hash: string; expiresAt: Date } {
  let raw = "";
  for (let i = 0; i < PAIRING_LENGTH; i++) raw += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
  return { code, hash: hashPairingCode(code), expiresAt: new Date(now.getTime() + PAIRING_TTL_MS) };
}
