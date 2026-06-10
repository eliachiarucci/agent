import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor, username } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { db } from "./db";
import * as schema from "./schema";
import { createAgent } from "../db/agents";

// The SPA origin; auth requests arrive proxied through it (Vite dev proxy /agent -> :3001),
// so cookies and WebAuthn are bound to this origin, not the API port.
const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:5173";

// Better Auth rejects cookie-carrying requests from origins outside the trusted
// set (INVALID_ORIGIN). This app is self-hosted at home and reached from many
// devices under many names (LAN IP, *.local, Tailscale hostname, …), so besides
// this static list there is a dynamic rule below trusting any private-network
// origin. Extra public origins (e.g. a real domain) go in the TRUSTED_ORIGINS
// env var, comma-separated.
const TRUSTED_ORIGINS = [
  ...new Set([
    APP_ORIGIN,
    "http://localhost:3001",
    ...(process.env.TRUSTED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
  ]),
];

// Origins that resolve into the home network. Browsers set the Origin header
// themselves, so a malicious *public* site cannot present a private origin —
// CSRF protection against the internet is unaffected; anything already running
// inside the LAN is outside this threat model.
function isPrivateOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
  // mDNS / common home suffixes and RFC 1918 + CGNAT (Tailscale) IPv4 ranges.
  if (/\.(local|lan|home\.arpa|internal|ts\.net)$/.test(host)) return true;
  return (
    /^10\.\d+\.\d+\.\d+$/.test(host) ||
    /^192\.168\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host)
  );
}

export const auth = betterAuth({
  baseURL: APP_ORIGIN,
  // Mounted under the existing /agent/* namespace so the Vite proxy covers it.
  basePath: "/agent/auth",
  secret: process.env.BETTER_AUTH_SECRET,
  // Also invoked once at startup without a request to seed the base list.
  trustedOrigins: (request?: Request) => {
    const origin = request?.headers.get("origin") ?? request?.headers.get("referer") ?? "";
    return isPrivateOrigin(origin) ? [...TRUSTED_ORIGINS, new URL(origin).origin] : TRUSTED_ORIGINS;
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      ...schema,
      // Our user table is plural and predates Better Auth.
      user: schema.users,
    },
  }),
  advanced: {
    database: {
      // Tables use uuid columns; user ids are UUIDv4 by project convention.
      generateId: () => crypto.randomUUID(),
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    username(),
    twoFactor(),
    passkey({
      rpID: new URL(APP_ORIGIN).hostname,
      rpName: "Agent",
      origin: APP_ORIGIN,
    }),
  ],
  databaseHooks: {
    user: {
      create: {
        // Every new account starts with a personal agent so the app is usable
        // immediately after signup.
        after: async (user) => {
          await createAgent({ name: "Personal Assistant", ownerId: user.id });
        },
      },
    },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
