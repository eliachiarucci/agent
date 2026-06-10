import { createHmac } from "node:crypto";

// Minimal RFC 6238 TOTP (SHA-1, 6 digits, 30s period — Better Auth's
// defaults), validated against Better Auth's verify-totp endpoint. Lives here
// instead of a library because otplib v13 moved to an async plugin
// architecture that buys nothing for generating codes in tests.

function base32Decode(encoded: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of encoded.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/** Current TOTP code for a base32 secret or an otpauth:// URI (as returned by 2FA enable). */
export function totpCode(secretOrUri: string, now = Date.now()): string {
  const secret = secretOrUri.startsWith("otpauth://")
    ? new URL(secretOrUri).searchParams.get("secret")!
    : secretOrUri;

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));

  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}
