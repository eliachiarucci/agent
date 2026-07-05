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
- **Writes gated by default.** The Gmail toolset mirrors Claude's official
  connector surface: `search_threads`, `get_thread`, `list_labels`,
  `list_drafts`, `create_draft`, `send_email`, `create_label`,
  `label_message`/`unlabel_message`, `label_thread`/`unlabel_thread`. Every
  write tool defaults to the `ask` permission level — a fresh agent can read
  mail, but nothing mutates the mailbox (and above all nothing sends) without
  a human approving each call or setting the tool to `allow` in
  Settings → Tools.

## Moving parts

- Schema (`lib/global/schema.ts`): `connector_settings` — one row per
  (user, connector) holding `settings` (clientId/clientSecret), `tokens`
  (refresh + access token, expiry, scopes, connected email) and a `status`
  (`disconnected | connected | error`). `tool_permissions` — one row per
  (user, agent) with `{ [connector]: { [tool]: "deny" | "ask" | "allow" } }`;
  missing keys mean the tool's catalog default — `allow` for read tools, `ask`
  for write tools — so a freshly created agent never mutates anything without
  a human approving each call. `tool_approvals` — standing "always approve"
  overrides, one row per (user, agent, connector, tool, target); `target "*"`
  covers the whole tool (see Human approval below).
- OAuth (`lib/agent/connectors/google-auth.ts`): authorize-URL builder
  (`access_type=offline&prompt=consent&include_granted_scopes=true`), an
  HMAC-signed `state` (keyed by `BETTER_AUTH_SECRET`, 10-min TTL) binding the
  callback to the user who started the flow, code exchange (connected email
  decoded from the `id_token`), and access-token refresh: single-flight per
  user, persisted, `invalid_grant` flips the row to `status="error"` so tools
  are withheld and the UI offers a reconnect.
- Tools (`lib/agent/connectors/gmail.ts`): plain-`fetch` Gmail REST calls (no
  googleapis SDK). `get_thread` bodies are parsed for the model: prefer
  `text/plain`, fall back to html-to-text, normalize whitespace, never inline
  attached files (an attached `.txt`/`.html` is not the body), and list
  attachments/inline images by name+type+size instead of their bytes. An
  off-by-default `raw: true` option returns the original body source (plain
  text as sent + HTML source) when the cleaned text loses something. All
  bodies are capped (10k chars/message, 40k/thread) to protect local-model
  context windows. Errors return `{ error }` tool results instead of throwing.
- Assembly (`lib/agent/connectors/index.ts`): `buildConnectorTools({ userId,
  agentId, interactive })` returns the tools of every *connected* connector
  filtered by the sender's per-agent permission levels, plus the matching
  system-prompt sections. `allow` tools are always offered; `ask` tools are
  offered with a `needsApproval` gate in interactive runs (the chat route) and
  withheld like `deny` in headless runs (cron — nobody is there to ask). The
  prompt/toolset is stable per (user, agent, settings), so the KV-cache prefix
  rule holds.
- Routes: `GET /agent/connectors` (catalog + masked config; secrets and tokens
  never leave the server), `POST/DELETE /agent/connectors/gmail` (save
  credentials / disconnect+revoke), `GET /agent/connectors/gmail/authorize`
  (302 to Google), `GET /agent/connectors/gmail/callback` (exchange + redirect
  back to the SPA with `?connector=gmail&connector_status=...`),
  `GET/POST /agent/tool-permissions?agent_id=` and
  `GET/DELETE /agent/tool-approvals` (membership-checked).
- UI (`../agent-ui`, Settings → Tools): agent selector on top (permissions are
  per agent), then a collapsible card per connector with the setup wizard
  (links, copyable redirect URI, credential form) and — once connected — a
  Deny / Ask / Allow control per tool, grouped read/write. The OAuth callback
  lands back in the SPA, which toasts and reopens Settings → Tools. An
  "Approval overrides" dialog lists the stored always-approve combinations and
  lets the user revoke them.

## Human approval ("ask" tools)

The AI SDK's native tool-approval flow, end to end:

- **Pause.** In chat turns, an `ask`-level tool is built with `needsApproval`:
  when the model calls it, the check first consults `tool_approvals` (standing
  overrides). Covered → the call runs like `allow`. Not covered → `streamText`
  emits a `tool-approval-request` and the stream closes with the tool part in
  state `approval-requested`; `onFinish` persists it. The agent needs no
  awareness of any of this — it prepares the call normally.
- **Prompt.** The UI (`agent-ui` `tool-approval.tsx`, rendered by ToolPart)
  shows what the agent wants to run — tool name, targets (e.g. draft
  recipients), full input — with three choices: Approve once, Always approve
  (this tool + target combination), Deny. The composer is blocked while a
  prompt is pending; decisions go through `addToolApprovalResponse` and, once
  every pending prompt is answered, the chat auto-resends
  (`sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`).
- **Resume.** The resume request carries `tool_approvals: [{ approval_id,
  approved, always }]` instead of a message. The conversation route patches the
  stored history (parts → `approval-responded`), stores overrides for
  `always: true` (targets derived server-side via `connectorApprovalTargets` —
  never client-supplied), and re-runs `streamText`, which executes approved
  calls and turns denials into `execution-denied` tool results the model reacts
  to. The continuation streams into the same assistant message
  (`createUIMessageStream({ originalMessages })` reuses its id). Only the turn's
  sender may respond (the pending call runs on their credentials).
- **Deny-only turns skip the model.** When every decision is a denial there is
  nothing to execute and the agent doesn't get to reply to a plain "no": the
  route records the denied results on the conversation (`output-denied`, which
  the model sees as `execution-denied` on its next turn) and streams only
  `tool-output-denied` chunks to flip the client's pending parts — no
  `streamText`, no model needed at all. Mixed batches (some approved) resume
  the model normally. This path runs before model resolution, so it works even
  with no model configured.
- **Targets.** Per-tool derivation (`gmail.ts` `gmailApprovalTargets`):
  `create_draft` → each recipient email (lowercased; one override row per
  recipient, a call is covered only when *all* recipients are). Tools without a
  target concept store a single `"*"` row covering every call.
- **Interrupted prompts.** If the user sends a new message instead of deciding,
  the route flips pending prompts to `output-denied` ("user sent a new message
  instead") so the model never sees dangling tool calls.

## Troubleshooting the consent flow

Errors Google shows on its own pages during consent (observed in the field):

- **`Error 403: access_denied` — "has not completed the Google verification
  process"**: the app is in Testing status and the Google account being
  connected is not on its test-user list. Add the exact address under Google
  Auth Platform → Audience → Test users. Do *not* publish to production
  instead: unverified production apps are hard-blocked for Gmail's restricted
  scopes.
- **"Google hasn't verified this app" interstitial**: expected for test users
  of an app in Testing status — click Continue.
- **`Error 400: policy_enforced` — "not approved by Advanced Protection"**:
  the Google account is enrolled in the Advanced Protection Program, which
  only lets Google-verified apps touch Gmail/Drive data. There is no
  self-hosted workaround for consumer accounts (Claude's own connectors pass
  because Anthropic's OAuth client is verified). Options: connect a non-APP
  account, unenroll, use a Workspace account whose admin trusts the app, or
  get the client verified. Calendar scopes are only "sensitive", so a future
  Calendar connector works under APP even unverified.

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
