import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getConnectorSetting,
  setConnectorStatus,
  setConnectorTokens,
  type ConnectorSetting,
} from "../../db/connectors";
import type { ConnectorTokens, ConnectorType } from "../../global/schema";

// Google's real OAuth endpoints; env-overridable so tests can point them at a
// local stub instead of the network.
const GOOGLE_AUTH_URL =
  process.env.GOOGLE_OAUTH_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL ?? "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL =
  process.env.GOOGLE_OAUTH_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke";

const FETCH_TIMEOUT_MS = 15_000;
// Refresh when the access token has less than this long to live, so a token
// can't expire mid-request.
const EXPIRY_SLACK_MS = 60_000;
// The consent redirect should be used promptly; stale states are rejected.
const STATE_TTL_MS = 10 * 60_000;

// Google requires HTTPS redirect URIs (localhost excepted), so connecting a
// Google account needs the app served over HTTPS or accessed via localhost.
export function connectorRedirectUri(connector: ConnectorType): string {
  const origin = process.env.APP_ORIGIN ?? "http://localhost:5173";
  return `${origin.replace(/\/+$/, "")}/agent/connectors/${connector}/callback`;
}

/** Thrown when a connector has no usable tokens; tools surface it as a friendly error. */
export class ConnectorAuthError extends Error {}

// ── OAuth state ──────────────────────────────────────────────────────────────
// The `state` round-trips through Google and comes back on the callback; an
// HMAC (keyed by the auth secret) binds it to the user who started the flow so
// a forged callback can't attach someone else's Google account.

type StatePayload = { userId: string; connector: ConnectorType; exp: number };

function stateSecret(): string {
  return process.env.BETTER_AUTH_SECRET ?? "dev-insecure-secret";
}

function signPayload(encoded: string): Buffer {
  return createHmac("sha256", stateSecret()).update(encoded).digest();
}

export function signState(userId: string, connector: ConnectorType): string {
  const payload: StatePayload = { userId, connector, exp: Date.now() + STATE_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signPayload(encoded).toString("base64url")}`;
}

export function verifyState(state: string): StatePayload | null {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  const expected = signPayload(encoded);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString()) as StatePayload;
    if (typeof payload.userId !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Authorize URL ────────────────────────────────────────────────────────────

export function buildAuthorizeUrl(opts: {
  clientId: string;
  connector: ConnectorType;
  scopes: string[];
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: connectorRedirectUri(opts.connector),
    response_type: "code",
    scope: opts.scopes.join(" "),
    // offline + consent guarantees a refresh token on every connect; granted
    // scopes accumulate so adding Calendar/Drive later won't re-prompt for Gmail.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

// ── Token exchange & refresh ─────────────────────────────────────────────────

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function postToken(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  return (await res.json()) as TokenResponse;
}

// The id_token arrives straight from Google over TLS during the code exchange,
// so its payload is trusted without signature verification.
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString()) as {
      email?: unknown;
    };
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

export async function exchangeCode(opts: {
  clientId: string;
  clientSecret: string;
  connector: ConnectorType;
  code: string;
}): Promise<ConnectorTokens> {
  const body = await postToken({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: connectorRedirectUri(opts.connector),
  });
  if (!body.access_token || !body.refresh_token) {
    throw new Error(
      body.error_description ?? body.error ?? "Google did not return tokens for the code exchange"
    );
  }
  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    accessTokenExpiresAt: Date.now() + (body.expires_in ?? 0) * 1000,
    scopes: body.scope?.split(" ") ?? [],
    email: emailFromIdToken(body.id_token),
  };
}

// Single-flight per (user, connector): parallel tool calls share one refresh
// instead of racing Google with the same refresh token.
const refreshing = new Map<string, Promise<string>>();

/**
 * A valid access token for the user's connector, refreshing (and persisting)
 * it when near expiry. Throws ConnectorAuthError when the connector is not
 * connected or Google rejected the refresh token (revoked / expired).
 */
export async function getConnectorAccessToken(
  userId: string,
  connector: ConnectorType
): Promise<string> {
  const row = await getConnectorSetting(userId, connector);
  if (!row?.tokens) {
    throw new ConnectorAuthError(
      `The ${connector} connector is not connected. Connect it in Settings → Tools.`
    );
  }
  if (row.tokens.accessTokenExpiresAt - EXPIRY_SLACK_MS > Date.now()) {
    return row.tokens.accessToken;
  }

  const key = `${userId}:${connector}`;
  const inFlight = refreshing.get(key);
  if (inFlight) return inFlight;

  const task = refreshTokens(row).finally(() => refreshing.delete(key));
  refreshing.set(key, task);
  return task;
}

async function refreshTokens(row: ConnectorSetting): Promise<string> {
  const tokens = row.tokens!;
  const body = await postToken({
    grant_type: "refresh_token",
    refresh_token: tokens.refreshToken,
    client_id: row.settings.clientId ?? "",
    client_secret: row.settings.clientSecret ?? "",
  });
  if (!body.access_token) {
    // invalid_grant = the refresh token itself is dead (user revoked access, or
    // a testing-mode Google app expired it): flag the row so the UI offers a
    // reconnect and tools stop being offered.
    if (body.error === "invalid_grant") {
      await setConnectorStatus(row.userId, row.connector, "error");
      throw new ConnectorAuthError(
        `The ${row.connector} connection expired or was revoked. Reconnect it in Settings → Tools.`
      );
    }
    throw new Error(
      body.error_description ?? body.error ?? `Refreshing the ${row.connector} token failed`
    );
  }
  const next: ConnectorTokens = {
    ...tokens,
    accessToken: body.access_token,
    accessTokenExpiresAt: Date.now() + (body.expires_in ?? 0) * 1000,
    // Google occasionally rotates the refresh token; keep the old one otherwise.
    refreshToken: body.refresh_token ?? tokens.refreshToken,
  };
  await setConnectorTokens(row.userId, row.connector, next, "connected");
  return next.accessToken;
}

/** Best-effort revocation at Google when the user disconnects; never throws. */
export async function revokeConnectorTokens(tokens: ConnectorTokens): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: tokens.refreshToken }).toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    // The row is deleted regardless; a dangling grant can be revoked from the
    // user's Google account page.
  }
}
