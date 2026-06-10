# Agent

A personal assistant that runs entirely on local models (LM Studio) with long-term memory:
facts about users are stored in Postgres with pgvector embeddings and retrieved
semantically on every turn, blended by relevance, recency, importance, and subject match.

Multi-tenant: users own agents, each agent has its own isolated memory pool, and owners
can share agents with other users (sharing an agent shares its memory). Conversations are
private to their creator by default; `shared: true` makes them visible to all agent members.
Memories are phrased in third person with names and carry a `subject_user_id` (`NULL` =
shared/group fact) so a shared agent keeps each member's facts straight.

Detailed docs live in [docs/](docs/) — start with [docs/memory.md](docs/memory.md) for the memory system.

## Project notes

- **Requirements:** Node 22+, Docker (Postgres + pgvector via `docker compose up -d db`), and LM Studio on `localhost:1234` with a chat model and `text-embedding-nomic-embed-text-v1.5` loaded.
- **Backend (this repo):** Express + AI SDK v6 + Drizzle. Files in `api/` are auto-mounted as routes by an esbuild plugin (`api/agent/conversation.ts` → `POST /agent/conversation`); exported `GET`/`POST`/etc. handlers map to methods.
- `npm run dev` — esbuild watch + server on port 3001. `npm run db:push` — push schema changes (schema in `lib/global/schema.ts`).
- **Auth:** Better Auth (`lib/global/auth.ts`), mounted at `/agent/auth/*` in `index.ts` **before** `express.json()` (it parses its own body). Username+password, TOTP 2FA, and passkeys (plugins: `username`, `twoFactor`, `passkey`). Session cookie identifies the user on every route (`getSessionUser`/`resolveActor` in `lib/agent/actor.ts`); `agent_id` stays an optional param defaulting to the user's oldest agent. Signup auto-creates a "Personal Assistant" agent (databaseHook). Auth tables live in `lib/global/schema.ts` and must match `getAuthTables(auth.options)` — re-check after adding auth plugins. Requires `BETTER_AUTH_SECRET` and `APP_ORIGIN` in `.env`. Designed for home self-hosting: any private-network origin (RFC 1918 / CGNAT IPs, `.local`/`.lan`/`.ts.net`/`.home.arpa` hosts) is trusted dynamically for CSRF purposes; public origins must be listed in `TRUSTED_ORIGINS`. Passkeys are bound to the `APP_ORIGIN` hostname and need a secure context (HTTPS or localhost).
- Domain logic lives in `lib/`: `lib/db/` (Drizzle queries), `lib/agent/` (memory + web-search tools and prompts), `lib/global/` (db client, AI provider, schema).
- Models are env-configurable: `CHAT_MODEL` (default `google/gemma-4-e4b`), `EMBEDDING_MODEL` (768 dims, must match the `vector(768)` column). Use `lmstudio.chat(...)` / Chat Completions — LM Studio's `/v1/responses` support is incomplete.
- The system prompt must stay stable per session (KV-cache reuse); per-turn retrieved memories are appended to the user message as a `<relevant-memories>` block instead. See docs/memory.md before changing prompt assembly.
- **UI (separate repo, `../agent-ui`):** Vite + React 19 + Tailwind 4 + shadcn, streams chat via `@ai-sdk/react`. It strips `<relevant-memories>` blocks when rendering user messages.
