import express from "express";
import { getSessionUser } from "../../../../lib/agent/actor";
import { exchangeCode, verifyState } from "../../../../lib/agent/connectors/google-auth";
import { getConnectorSetting, setConnectorTokens } from "../../../../lib/db/connectors";

export const config = {};

// The browser ends up back in the SPA either way; the UI reads these params on
// load and shows a toast / reopens Settings → Tools.
function finish(res: express.Response, status: "connected" | "error", message?: string) {
  const origin = (process.env.APP_ORIGIN ?? "http://localhost:5173").replace(/\/+$/, "");
  const params = new URLSearchParams({ connector: "gmail", connector_status: status });
  if (message) params.set("connector_error", message.slice(0, 200));
  res.redirect(`${origin}/?${params}`);
}

export const OPTIONS: express.RequestHandler = async (req, res) => {
  res.set("Allow", "GET, OPTIONS");
  res.sendStatus(204);
};

// Google's consent screen redirects here. Top-level GET navigation sends the
// session cookie (SameSite=Lax), so the caller is authenticated; the signed
// state must additionally match that same user.
export const GET: express.RequestHandler = async (req, res) => {
  const { code, state, error } = req.query;
  if (typeof error === "string" && error) {
    finish(res, "error", error === "access_denied" ? "Access was denied" : error);
    return;
  }
  if (typeof code !== "string" || typeof state !== "string") {
    finish(res, "error", "Missing code or state");
    return;
  }

  const user = await getSessionUser(req);
  const payload = verifyState(state);
  if (!user || !payload || payload.userId !== user.id || payload.connector !== "gmail") {
    finish(res, "error", "Invalid or expired authorization state");
    return;
  }

  const setting = await getConnectorSetting(user.id, "gmail");
  if (!setting?.settings.clientId || !setting.settings.clientSecret) {
    finish(res, "error", "OAuth client is no longer configured");
    return;
  }

  try {
    const tokens = await exchangeCode({
      clientId: setting.settings.clientId,
      clientSecret: setting.settings.clientSecret,
      connector: "gmail",
      code,
    });
    await setConnectorTokens(user.id, "gmail", tokens, "connected");
    finish(res, "connected");
  } catch (err) {
    finish(res, "error", err instanceof Error ? err.message : "Token exchange failed");
  }
};
