# Conversation files (artifacts and uploads)

Agents can write files — documents, code, plans — that persist beyond the chat
stream and that users can download from the UI's Files view. Users can attach
files the other way: long pasted text and chat images upload into the same
per-conversation workspace.

## Storage model

Files live on disk, not in Postgres. The layout is one folder per conversation,
with user uploads in an `uploads/` subfolder (`FileSource`: `"agent"` vs
`"upload"` — same name in both sources means two distinct files):

```
$FILES_DIR/<conversation id>/<file name>            # agent-written artifacts
$FILES_DIR/<conversation id>/uploads/<file name>    # user uploads (images, pasted text)
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
`readFile` looks in the agent folder first, then falls back to `uploads/` (the
`<attached-files>` flow stores attachments there).

Guardrails: file names are plain names (no slashes, traversal, control chars,
max 128 chars — `isValidFileName`), tool-written content is capped at 1 MiB,
uploads at 10 MiB (`MAX_UPLOAD_BYTES`), and a conversation holds at most 100
files across both sources.

## HTTP API

- `GET /agent/files?agent_id=` — flat list of every file in the agent's
  conversations visible to the viewer:
  `[{ conversationId, name, size, updatedAt, source }]`, newest first.
  `agent_id` defaults to the user's oldest agent, like the other routes.
- `POST /agent/files?conversation_id=&name=` — upload raw bytes (any non-JSON
  content type; the body is the file verbatim) into the conversation's
  `uploads/` folder. Works for a not-yet-created conversation id (the client
  generates it; the first message creates the row). 201 with the stored entry.
- `DELETE /agent/files?conversation_id=&name=` — remove one upload (e.g. an
  image detached in the composer before sending). Only uploads are deletable.
- `GET /agent/files/download?conversation_id=&name=&source=` — streams the file
  with `Content-Disposition: attachment` (so browsers download instead of
  rendering HTML on the app origin). Access-checked like reading the
  conversation. `source` defaults to `agent`; pass `upload` for uploads.
- `GET /agent/files/content?conversation_id=&name=&source=` — the file as JSON
  (`{ name, content, size, updatedAt }`, utf8 text) for the viewer panel, same
  access rules (shared logic: `resolveConversationViewer` in
  `lib/agent/actor.ts`). Images render via the download route instead.

The UI (`../agent-ui`) shows these in the sidebar's Files dialog
(`src/components/files/files-dialog.tsx`) as two folders — agent files and
uploaded files — each a flat list with view/download links.

## Chat images

The composer's attach button (shown unless `/agent/context` reports
`supportsImages: false` for the selected model) opens the native picker
filtered to PNG/JPEG/WebP/GIF (`IMAGE_MEDIA_TYPES`, mirrored in the UI). Each
picked image uploads immediately to the conversation's `uploads/` folder under
a uniquified name (re-using a name would overwrite the upload an earlier
message references); square previews sit above the input, removable (which
deletes the upload) until sent, up to 20 per message.

On send, the request carries `images: [{ name }]` and the route stores real AI
SDK file parts on the user message
(`{ type: "file", mediaType, filename, url }`, built in
`lib/agent/image-parts.ts`), with `url` pointing at the app's own download
route so the UI can render thumbnails with the session cookie. Providers can't
fetch that URL, so right before `convertToModelMessages` the model's copy of
the history swaps each part's URL for a `data:` URL read from disk
(`inlineImageFileParts`); a missing upload degrades to a text note. The base64
payload is deterministic, so the prompt prefix stays KV-cache stable across
turns. Compaction transcripts keep an `[attached image: name]` trace; memory
extraction and retrieval ignore file parts.

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

- `test/unit/files.test.ts` — storage helpers against a temp `FILES_DIR`
  (both sources, media types, upload deletion).
- `test/unit/image-parts.test.ts` — file-part building and data-URL inlining.
- `test/api/files.test.ts` — list/upload/download/delete visibility over HTTP.
  Test servers get `FILES_DIR=dist/test-files-<port>` (wiped on server start);
  tests seed conversations in the DB and files on disk via the same helpers.
- `test/api/chat-images.test.ts` — the chat route's image handling (file parts
  persist before streaming, so no model is needed).
