# Connectors (Gmail, Google Calendar)

Connectors give the agent tools backed by the user's external accounts, in the
style of Claude's official connectors. Gmail and Google Calendar exist today;
Drive is designed to slot in next to them (same OAuth plumbing, one new tool
module + catalog entry each — see `CONNECTOR_CATALOG` in
`lib/agent/connectors/index.ts`).

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
- **Writes gated by default.** The toolsets mirror Claude's official connector
  surfaces where they have an equivalent. Gmail: `search_threads`,
  `get_thread`, `list_labels`, `list_drafts`, `create_draft`, `send_email`,
  `create_label`, `label_message`/`unlabel_message`,
  `label_thread`/`unlabel_thread`. Google Calendar: `list_calendars`,
  `list_events`, `get_event`, `find_free_time`, `create_event`,
  `update_event`, `delete_event`, `respond_to_event`. Every write tool
  defaults to the `ask` permission level — a fresh agent can read mail and
  calendars, but nothing mutates anything (and above all nothing sends email
  or invitations) without a human approving each call or setting the tool to
  `allow` in Settings → Tools.

## Moving parts

- Schema (`lib/global/schema.ts`): `connector_settings` — one row per
  (user, connector) holding `settings` (clientId/clientSecret), `tokens`
  (refresh + access token, expiry, scopes, connected email), a `status`
  (`disconnected | connected | error`) and `enabled` (the card's on/off
  switch, default true — see Enable/disable below). `tool_permissions` — one row per
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
- Tools (`lib/agent/connectors/gmail.ts`, `google-calendar.ts`; shared
  catalog/permission-filtering helpers in `shared.ts`): plain-`fetch` REST
  calls (no googleapis SDK). `get_thread` bodies are parsed for the model:
  prefer `text/plain`, fall back to html-to-text, normalize whitespace, never
  inline attached files (an attached `.txt`/`.html` is not the body), and list
  attachments/inline images by name+type+size instead of their bytes. An
  off-by-default `raw: true` option returns the original body source (plain
  text as sent + HTML source) when the cleaned text loses something. All
  bodies are capped (10k chars/message, 40k/thread; 5k/event description) to
  protect local-model context windows. Errors return `{ error }` tool results
  instead of throwing. Calendar tools take one time string and route it by
  shape (bare `YYYY-MM-DD` → all-day `{date}`, otherwise `{dateTime}` with an
  optional IANA `time_zone`); event writes carry `notify_attendees`
  (default true → `sendUpdates=all`), and `respond_to_event` patches the
  user's own attendee entry while sending the list back whole (a PATCH on
  `attendees` replaces it).
- Assembly (`lib/agent/connectors/index.ts`): `buildConnectorTools({ userId,
  agentId, interactive, headlessAskPolicy })` returns the tools of every
  *connected* connector filtered by the sender's per-agent permission levels,
  plus the matching system-prompt sections. `allow` tools are always offered;
  `ask` tools are offered with a `needsApproval` gate in interactive runs (the
  chat route) and withheld like `deny` in headless runs (cron — nobody is
  there to ask), unless the run passes `headlessAskPolicy: "allow"` (a cron
  job whose creator set `ask_policy` to `allow` — the gated tools run
  unattended for that job only). The prompt/toolset is stable per (user,
  agent, settings), so the KV-cache prefix rule holds.
- Routes: `GET /agent/connectors` (catalog + masked config; secrets and tokens
  never leave the server), then per connector (`gmail`, `google-calendar` —
  thin instantiations of the factories in `api/agent/connectors.ts`):
  `POST/PATCH/DELETE /agent/connectors/<id>` (save credentials / toggle
  `enabled` / disconnect+revoke), `GET /agent/connectors/<id>/authorize` (302
  to Google),
  `GET /agent/connectors/<id>/callback` (exchange + redirect back to the SPA
  with `?connector=<id>&connector_status=...`),
  `GET/POST /agent/tool-permissions?agent_id=` and
  `GET/DELETE /agent/tool-approvals` (membership-checked).
- UI (`../agent-ui`, Settings → Tools): agent selector on top (permissions are
  per agent), then a collapsible card per connector with the setup wizard
  (links, copyable redirect URI, credential form) and — once connected — an
  on/off switch in the card header (before the expand chevron) plus a
  Deny / Ask / Allow control per tool, grouped read/write. The OAuth callback
  lands back in the SPA, which toasts and reopens Settings → Tools. An
  "Approval overrides" dialog lists the stored always-approve combinations and
  lets the user revoke them.

## Enable/disable (the card's switch)

Each connected connector card has an on/off switch: off keeps the credentials,
tokens and per-agent permission levels exactly as they are but withholds the
connector completely — `buildConnectorTools` skips it, so neither its tools
nor its system-prompt section reach the model, in chat and cron alike.
Re-enabling needs no reconnect. `PATCH /agent/connectors/<id>` with
`{ enabled }`; 404 until credentials are stored (nothing to disable). It is
per user, like the connection itself — every agent the user talks to is
affected.

KV-cache note: really removing a tool necessarily changes the request prefix
(the tools block and the prompt section), so the first turn after a flip runs
cold — same class of event as changing a tool permission or connecting a new
connector. The design keeps that cost to exactly one invalidation: the flag is
read per turn (never mid-turn), connectors are assembled in fixed
`CONNECTOR_TYPES` order with everything else byte-identical, and between flips
the prefix is stable again. Withholding is deliberately *not* done by stubbing
the tools out (which would preserve the cache but leave the tool names and
descriptions visible to the model): off means the model cannot see or call the
connector at all.

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
- **Targets.** Per-tool derivation (each connector's `*ApprovalTargetsFor`):
  `create_draft`/`send_email` → each recipient email,
  `create_event`/`update_event` → each attendee email (lowercased; one
  override row per address, a call is covered only when *all* of them are).
  Attendee-less calendar writes get a `"(no attendees)"` sentinel target
  instead of none — an empty list would store a tool-wide `"*"` wildcard, and
  approving an event that emails nobody must not silently cover future
  invite-sending calls. Tools without a target concept store a single `"*"`
  row covering every call.
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
  get the client verified. Calendar scopes are only "sensitive", so the
  Calendar connector works under APP even unverified.

## Google constraints worth knowing

- **Redirect URIs must be HTTPS** (localhost excepted): connecting requires the
  app to be reached over HTTPS (reverse proxy, Tailscale cert) or localhost —
  same class of constraint as passkeys.
- Gmail scopes are "restricted": a personal OAuth app in **testing** status
  gets refresh tokens that expire after 7 days (weekly reconnect). Google
  Workspace users can set the consent screen to **Internal** and avoid both the
  cap and the expiry. `status="error"` + the UI's reconnect button handle the
  expiry gracefully either way. Calendar scopes are only "sensitive", so a
  calendar-only connection does not hit the 7-day expiry.
- Each connector needs its API enabled in the user's Cloud project (Gmail API /
  Google Calendar API — the setup wizard links the right one), but one OAuth
  client can serve all connectors: the authorize URL sends
  `include_granted_scopes=true`, so consenting to Calendar keeps earlier Gmail
  grants.
- The OAuth/API endpoints are env-overridable (`GOOGLE_OAUTH_AUTH_URL`,
  `GOOGLE_OAUTH_TOKEN_URL`, `GOOGLE_OAUTH_REVOKE_URL`, `GMAIL_API_BASE`,
  `GOOGLE_CALENDAR_API_BASE`) so tests can stub Google locally; unit tests
  cover the state HMAC, refresh single-flight/invalid_grant, MIME parsing,
  draft assembly, event time routing/shaping and permission filtering, api
  tests cover the routes.
