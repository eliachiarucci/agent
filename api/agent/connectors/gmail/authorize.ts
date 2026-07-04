import express from "express";
import { getSessionUser } from "../../../../lib/agent/actor";
import { buildAuthorizeUrl, signState } from "../../../../lib/agent/connectors/google-auth";
import { GMAIL_SCOPES } from "../../../../lib/agent/connectors/gmail";
import { getConnectorSetting } from "../../../../lib/db/connectors";

export const config = {};

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// Starts the OAuth flow: 302 to Google's consent screen. The browser lands on
// /agent/connectors/gmail/callback afterwards; the signed state ties that
// callback to this user.
export const GET: express.RequestHandler = async (req, res) => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const setting = await getConnectorSetting(user.id, "gmail");
  if (!setting?.settings.clientId || !setting.settings.clientSecret) {
    res.status(400).json({ error: "Save the OAuth client id and secret first" });
    return;
  }

  res.redirect(
    buildAuthorizeUrl({
      clientId: setting.settings.clientId,
      connector: "gmail",
      scopes: GMAIL_SCOPES,
      state: signState(user.id, "gmail"),
    })
  );
};
