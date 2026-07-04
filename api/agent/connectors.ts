import express from "express";
import { getSessionUser } from "../../lib/agent/actor";
import { CONNECTOR_CATALOG } from "../../lib/agent/connectors";
import { connectorRedirectUri } from "../../lib/agent/connectors/google-auth";
import { listConnectorSettings, type ConnectorSetting } from "../../lib/db/connectors";
import { CONNECTOR_TYPES } from "../../lib/global/schema";

export const config = {};

// Client secrets and tokens never leave the server; the UI learns only whether
// a secret is stored and which account is connected.
export function maskConnectorSetting(connector: (typeof CONNECTOR_TYPES)[number], row?: ConnectorSetting) {
  const catalog = CONNECTOR_CATALOG[connector];
  return {
    connector,
    name: catalog.name,
    scopes: catalog.scopes,
    tools: catalog.tools,
    // What the wizard tells the user to register on their OAuth client.
    redirectUri: connectorRedirectUri(connector),
    clientId: row?.settings.clientId ?? null,
    hasClientSecret: Boolean(row?.settings.clientSecret),
    status: row?.status ?? "disconnected",
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
