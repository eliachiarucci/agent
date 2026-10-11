import { createHash, randomBytes } from "node:crypto";

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
