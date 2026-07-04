import express from "express";
import { z } from "zod";
import { getSessionUser } from "../../../lib/agent/actor";
import { revokeConnectorTokens } from "../../../lib/agent/connectors/google-auth";
import {
  deleteConnectorSetting,
  upsertConnectorSetting,
  withStoredClientSecret,
} from "../../../lib/db/connectors";
import { maskConnectorSetting } from "../connectors";

export const config = {};

const credentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
});

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "POST, DELETE, OPTIONS");
  res.sendStatus(204);
};

// Stores the user's own Google OAuth client for Gmail. The UI omits the secret
// when one is already stored (it is masked on GET), so restore it before
// validating. Changing the clientId resets any existing connection — tokens
// are bound to the client that issued them (lib/db/connectors.ts).
export const POST: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const input = await withStoredClientSecret(user.id, "gmail", req.body ?? {});
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues });
    return;
  }

  const row = await upsertConnectorSetting(user.id, "gmail", parsed.data);
  res.json(maskConnectorSetting("gmail", row));
};

// Disconnects and forgets the connector: best-effort token revocation at
// Google, then the row (credentials included) is removed.
export const DELETE: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const removed = await deleteConnectorSetting(user.id, "gmail");
  if (!removed) {
    res.status(404).json({ error: "Connector not configured" });
    return;
  }
  if (removed.tokens) await revokeConnectorTokens(removed.tokens);
  res.status(204).end();
};
