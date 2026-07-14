import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../lib/agent/actor";
import { CONNECTOR_CATALOG } from "../../lib/agent/connectors";
import {
  buildAuthorizeUrl,
  connectorRedirectUri,
  exchangeCode,
  revokeConnectorTokens,
  signState,
  verifyState,
} from "../../lib/agent/connectors/google-auth";
import {
  deleteConnectorSetting,
  getConnectorSetting,
  listConnectorSettings,
  setConnectorEnabled,
  setConnectorTokens,
  upsertConnectorSetting,
  withStoredClientSecret,
  type ConnectorSetting,
} from "../../lib/db/connectors";
import { CONNECTOR_TYPES, type ConnectorType } from "../../lib/global/schema";

export const config = {};

// Client secrets and tokens never leave the server; the UI learns only whether
// a secret is stored and which account is connected.
export function maskConnectorSetting(connector: ConnectorType, row?: ConnectorSetting) {
  const catalog = CONNECTOR_CATALOG[connector];
  return {
    connector,
    name: catalog.name,
    scopes: catalog.scopes,
    tools: catalog.tools,
    // What the wizard tells the user to register on their OAuth client. Per
    // connector: a client reused across connectors needs each one's URI added.
    redirectUri: connectorRedirectUri(connector),
    clientId: row?.settings.clientId ?? null,
    hasClientSecret: Boolean(row?.settings.clientSecret),
    status: row?.status ?? "disconnected",
    enabled: row?.enabled ?? true,
    email: row?.tokens?.email ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// Every known connector, merged with the caller's stored configuration.
export const GET: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const rows = await listConnectorSettings(user.id);
  res.json(
    CONNECTOR_TYPES.map((connector) =>
      maskConnectorSetting(connector, rows.find((r) => r.connector === connector))
    )
  );
};

// ── Per-connector route handlers ─────────────────────────────────────────────
// Every connector mounts the same three routes (credentials, authorize,
// callback) parameterized only by its id — the route files under
// api/agent/connectors/<id>/ instantiate these factories.

const credentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

const toggleSchema = z.object({ enabled: z.boolean() });

/**
 * POST (store the user's own Google OAuth client), PATCH (the card's on/off
 * switch — withholds the connector's tools while keeping credentials and
 * tokens) and DELETE (disconnect and forget) for one connector. The UI omits
 * the secret when one is already stored (it is masked on GET), so restore it
 * before validating. Changing the clientId resets any existing connection —
 * tokens are bound to the client that issued them (lib/db/connectors.ts).
 */
export function connectorCredentialHandlers(connector: ConnectorType): {
  POST: express.RequestHandler;
  PATCH: express.RequestHandler;
  DELETE: express.RequestHandler;
} {
  return {
    POST: async (req, res) => {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const input = await withStoredClientSecret(user.id, connector, req.body ?? {});
      const parsed = credentialsSchema.safeParse(input);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }

      const row = await upsertConnectorSetting(user.id, connector, parsed.data);
      res.json(maskConnectorSetting(connector, row));
    },

    PATCH: async (req, res) => {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const parsed = toggleSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues });
        return;
      }

      // Only configured connectors can be toggled — with no row there is
      // nothing to disable.
      const row = await setConnectorEnabled(user.id, connector, parsed.data.enabled);
      if (!row) {
        res.status(404).json({ error: "Connector not configured" });
        return;
      }
      res.json(maskConnectorSetting(connector, row));
    },

    // Best-effort token revocation at Google, then the row (credentials
    // included) is removed.
    DELETE: async (req, res) => {
      const user = await getSessionUser(req);
      if (!user) {
        res.status(401).json({ error: "Not authenticated" });
        return;
      }

      const removed = await deleteConnectorSetting(user.id, connector);
      if (!removed) {
        res.status(404).json({ error: "Connector not configured" });
        return;
      }
      if (removed.tokens) await revokeConnectorTokens(removed.tokens);
      res.status(204).end();
    },
  };
}

/**
 * Starts the OAuth flow: 302 to Google's consent screen with the connector's
 * catalog scopes. The browser lands on /agent/connectors/<id>/callback
 * afterwards; the signed state ties that callback to this user.
 */
export function connectorAuthorizeHandler(connector: ConnectorType): express.RequestHandler {
  return async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const setting = await getConnectorSetting(user.id, connector);
    if (!setting?.settings.clientId || !setting.settings.clientSecret) {
      res.status(400).json({ error: "Save the OAuth client id and secret first" });
      return;
    }

    res.redirect(
      buildAuthorizeUrl({
        clientId: setting.settings.clientId,
        connector,
        scopes: CONNECTOR_CATALOG[connector].scopes,
        state: signState(user.id, connector),
      })
    );
  };
}

// The browser ends up back in the SPA either way; the UI reads these params on
// load and shows a toast / reopens Settings → Tools.
function finishCallback(
  res: express.Response,
  connector: ConnectorType,
  status: "connected" | "error",
  message?: string
) {
  const origin = (process.env.APP_ORIGIN ?? "http://localhost:5173").replace(/\/+$/, "");
  const params = new URLSearchParams({ connector, connector_status: status });
  if (message) params.set("connector_error", message.slice(0, 200));
  res.redirect(`${origin}/?${params}`);
}

/**
 * Google's consent screen redirects here. Top-level GET navigation sends the
 * session cookie (SameSite=Lax), so the caller is authenticated; the signed
 * state must additionally match that same user and connector.
 */
export function connectorCallbackHandler(connector: ConnectorType): express.RequestHandler {
  return async (req, res) => {
    const { code, state, error } = req.query;
    if (typeof error === "string" && error) {
      finishCallback(res, connector, "error", error === "access_denied" ? "Access was denied" : error);
      return;
    }
    if (typeof code !== "string" || typeof state !== "string") {
      finishCallback(res, connector, "error", "Missing code or state");
      return;
    }

    const user = await getSessionUser(req);
    const payload = verifyState(state);
    if (!user || !payload || payload.userId !== user.id || payload.connector !== connector) {
      finishCallback(res, connector, "error", "Invalid or expired authorization state");
      return;
    }

    const setting = await getConnectorSetting(user.id, connector);
    if (!setting?.settings.clientId || !setting.settings.clientSecret) {
      finishCallback(res, connector, "error", "OAuth client is no longer configured");
      return;
    }

    try {
      const tokens = await exchangeCode({
        clientId: setting.settings.clientId,
        clientSecret: setting.settings.clientSecret,
        connector,
        code,
      });
      await setConnectorTokens(user.id, connector, tokens, "connected");
      finishCallback(res, connector, "connected");
    } catch (err) {
      finishCallback(res, connector, "error", err instanceof Error ? err.message : "Token exchange failed");
    }
  };
}
