# Connectors (Gmail)

Connectors give the agent tools backed by the user's external accounts, in the
style of Claude's official connectors. Gmail is the first one; Google Calendar
and Drive are designed to slot in next to it (same OAuth plumbing, one new tool
module + catalog entry each).

## Design

- **Per-user, not per-agent.** A Google account is personal, so credentials and
  tokens hang off the *sender* (like chat provider settings), never the agent.
  In a chat turn and in cron runs, the connector tools resolve against the
  message sender / job creator.
- **Bring-your-own OAuth client.** There is no vendor in the middle: each user
  creates a Google Cloud OAuth client (Settings → Tools walks through it, ~10
  minutes once) and pastes the client id/secret. The consent screen then looks
  exactly like connecting any app — Google account picker, permission list —
  and tokens are held only by this server.
- **Drafts only, never send.** The Gmail toolset mirrors Claude's official
  connector surface: `search_threads`, `get_thread`, `list_labels`,
  `list_drafts`, `create_draft`, `create_label`, `label_message`/`unlabel_message`,
  `label_thread`/`unlabel_thread`. The requested scopes (`gmail.readonly`,
  `gmail.compose`, `gmail.labels`) cannot send mail; `create_draft` leaves the
  human to press Send in Gmail.

## Moving parts

- Schema (`lib/global/schema.ts`): `connector_settings` — one row per
  (user, connector) holding `settings` (clientId/clientSecret), `tokens`
  (refresh + access token, expiry, scopes, connected email) and a `status`
  (`disconnected | connected | error`). `tool_permissions` — one row per
  (user, provider, model) with `{ [connector]: { [tool]: boolean } }`; missing
  keys mean enabled.
- OAuth (`lib/agent/connectors/google-auth.ts`): authorize-URL builder
  (`access_type=offline&prompt=consent&include_granted_scopes=true`), an
  HMAC-signed `state` (keyed by `BETTER_AUTH_SECRET`, 10-min TTL) binding the
  callback to the user who started the flow, code exchange (connected email
  decoded from the `id_token`), and access-token refresh: single-flight per
  user, persisted, `invalid_grant` flips the row to `status="error"` so tools
  are withheld and the UI offers a reconnect.
- Tools (`lib/agent/connectors/gmail.ts`): plain-`fetch` Gmail REST calls (no
  googleapis SDK); thread bodies prefer `text/plain`, fall back to
  html-to-text, and are capped (10k chars/message, 40k/thread) to protect
  local-model context windows. Errors return `{ error }` tool results instead
  of throwing.
- Assembly (`lib/agent/connectors/index.ts`): `buildConnectorTools({ userId,
  provider, model })` returns the tools of every *connected* connector filtered
  by the model's permission toggles, plus the matching system-prompt sections.
  Wired into the chat route and the cron runner; the prompt/toolset is stable
  per (user, model, settings), so the KV-cache prefix rule holds.
- Routes: `GET /agent/connectors` (catalog + masked config; secrets and tokens
  never leave the server), `POST/DELETE /agent/connectors/gmail` (save
  credentials / disconnect+revoke), `GET /agent/connectors/gmail/authorize`
  (302 to Google), `GET /agent/connectors/gmail/callback` (exchange + redirect
  back to the SPA with `?connector=gmail&connector_status=...`),
  `GET/POST /agent/tool-permissions?provider=&model=`.
- UI (`../agent-ui`, Settings → Tools): model selector on top (permissions are
  per model), then a collapsible card per connector with the setup wizard
  (links, copyable redirect URI, credential form) and — once connected —
  per-tool switches grouped read/write. The OAuth callback lands back in the
  SPA, which toasts and reopens Settings → Tools.

## Google constraints worth knowing

- **Redirect URIs must be HTTPS** (localhost excepted): connecting requires the
  app to be reached over HTTPS (reverse proxy, Tailscale cert) or localhost —
  same class of constraint as passkeys.
- Gmail scopes are "restricted": a personal OAuth app in **testing** status
  gets refresh tokens that expire after 7 days (weekly reconnect). Google
  Workspace users can set the consent screen to **Internal** and avoid both the
  cap and the expiry. `status="error"` + the UI's reconnect button handle the
  expiry gracefully either way.
- The OAuth/Gmail endpoints are env-overridable (`GOOGLE_OAUTH_AUTH_URL`,
  `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_OAUTH_REVOKE_URL`, `GMAIL_API_BASE`) so
  tests can stub Google locally; unit tests cover the state HMAC, refresh
  single-flight/invalid_grant, MIME parsing, draft assembly and permission
  filtering, api tests cover the routes.
