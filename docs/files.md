# Conversation files (artifacts)

Agents can write files — documents, code, plans — that persist beyond the chat
stream and that users can download from the UI's Files view.

## Storage model

Files live on disk, not in Postgres. The layout is one folder per conversation:

```
$FILES_DIR/<conversation id>/<file name>
```

- `FILES_DIR` defaults to `data/files` in dev (gitignored); deployments mount a
  Docker volume at `/files` and set `FILES_DIR=/files` (rendered by the
  agent-cli compose template).
- A conversation maps to exactly one folder, and a file always belongs to
  exactly one conversation. There are no nested folders and no file rows in the
  database — the folder name *is* the association.
- Visibility derives from the conversation: whoever can read a conversation
  (its creator, or any agent member when it is `shared`) can list and download
  its files. There is no separate ACL to keep in sync.
- Deleting a conversation (or its agent) removes the folder. Folders whose
  conversations disappear through other cascades (e.g. `users remove`) are
  orphaned on disk but never listed, since listing is driven by conversation
  rows.

Everything lives in [`lib/agent/files.ts`](../lib/agent/files.ts): storage
helpers, the agent tools, and the `filesPrompt` system-prompt section.

## Agent tools

Built per request by `buildFileTools(conversationId)` — the closure pins all
operations to the current conversation's folder; the schemas are static so the
prompt prefix stays KV-cache friendly (see [memory.md](memory.md)).

| Tool        | Purpose                                                        |
| ----------- | -------------------------------------------------------------- |
| `writeFile` | Create a file or replace its entire content.                   |
| `editFile`  | Replace an exact text snippet (all occurrences) in a file.     |
| `readFile`  | Read a file back (truncated at 20k chars for small contexts).  |
| `listFiles` | List the conversation's files with sizes.                      |
| `presentFile` | Open a file in the UI's viewer panel. The tool only verifies the file exists; the UI watches the message stream for the tool call and opens the viewer. |

Tool failures are returned as `{ error }` values so the model can self-correct.

Guardrails: file names are plain names (no slashes, traversal, control chars,
max 128 chars — `isValidFileName`), content is capped at 1 MiB, and a
conversation holds at most 100 files.

## HTTP API

- `GET /agent/files?agent_id=` — flat list of every file in the agent's
  conversations visible to the viewer:
  `[{ conversationId, name, size, updatedAt }]`, newest first. `agent_id`
  defaults to the user's oldest agent, like the other routes.
- `GET /agent/files/download?conversation_id=&name=` — streams the file with
  `Content-Disposition: attachment` (so browsers download instead of rendering
  HTML on the app origin). Access-checked like reading the conversation.
- `GET /agent/files/content?conversation_id=&name=` — the file as JSON
  (`{ name, content, size, updatedAt }`) for the viewer panel, same access
  rules (shared logic: `resolveConversationViewer` in `lib/agent/actor.ts`).

The UI (`../agent-ui`) shows these in the sidebar's Files dialog
(`src/components/files/files-dialog.tsx`) as one flat list with download links.

## File viewer (presentFile)

When the agent calls `presentFile`, the UI opens a viewer panel on the right
(`src/components/files/file-viewer.tsx` over in `../agent-ui`; an overlay
sliding in from the right on mobile, with a floating button to reopen it).
The workspace watches the message stream for the newest successful
`presentFile` tool part — including on mount, so reopening a conversation
restores its last presented file. Each successful file-tool chip in the chat
also gets a manual "View" button (via `FileViewerContext`).

- Tabs: every file touched by the conversation's file tools (in order of first
  appearance, derived in `src/lib/chat-files.ts`) becomes a tab when there is
  more than one.
- Rendering is by extension: `.md`/`.markdown` through react-markdown,
  `.html`/`.htm` in a sandboxed iframe (`sandbox="allow-scripts"`, no
  `allow-same-origin` — scripts run in an opaque origin with no access to the
  app), everything else as preformatted text.
- The top bar shows the file name with download, full-screen toggle (same
  panel re-rendered `fixed inset-0`), and close buttons.
- The panel polls `/agent/files/content` every 2s per open file and re-renders
  when `updatedAt`/content change, so agent edits show up live.

## Testing

- `test/unit/files.test.ts` — storage helpers against a temp `FILES_DIR`.
- `test/api/files.test.ts` — list/download visibility over HTTP. Test servers
  get `FILES_DIR=dist/test-files-<port>` (wiped on server start); tests seed
  conversations in the DB and files on disk via the same helpers.
