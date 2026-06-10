# Agent

A personal assistant that runs on local models (LM Studio chat, in-process embeddings) with long-term memory:
facts about users are stored in Postgres with pgvector embeddings and retrieved
semantically on every turn, blended by relevance, recency, importance, and subject match.

Multi-tenant: users own agents, each agent has its own isolated memory pool, and owners
can share agents with other users (sharing an agent shares its memory). Conversations are
private to their creator by default; `shared: true` makes them visible to all agent members.
Memories are phrased in third person with names and carry a `subject_user_id` (`NULL` =
shared/group fact) so a shared agent keeps each member's facts straight.

Detailed docs live in [docs/](docs/) — start with [docs/memory.md](docs/memory.md) for the memory system.

## Project notes

- **Requirements:** Node 22+, Docker (Postgres + pgvector via `docker compose up -d db`), and LM Studio on `localhost:1234` with a chat model loaded. Embeddings need no LM Studio: they run in-process (EmbeddingGemma via transformers.js/ONNX, ~300MB downloaded and cached on first use).
- **Backend (this repo):** Express + AI SDK v6 + Drizzle. Files in `api/` are auto-mounted as routes by an esbuild plugin (`api/agent/conversation.ts` → `POST /agent/conversation`); exported `GET`/`POST`/etc. handlers map to methods.
- `npm run dev` — esbuild watch + server on port 3001. `npm run build` — one-shot build to `dist/index.js` + `dist/users.js` (used by the Dockerfile). `npm run db:push` — push schema changes (schema in `lib/global/schema.ts`).
- **Migrations:** every schema change must also ship a committed migration: run `npx drizzle-kit generate` and commit `drizzle/` (the release workflow fails on drift). Deployed containers run `migrate()` at startup gated by `MIGRATE=on`; dev/test DBs stay on `db:push` — never set `MIGRATE=on` against a pushed DB (no migrations journal → it fails).

## Deployment (three repos)

End users install with `curl …/agent-cli/main/install.sh | bash` and manage everything through the `agent` CLI — full docs in [docs/install.md](docs/install.md). How it hangs together:

- Three repos, three artifacts: **this repo** → backend image `ghcr.io/eliachiarucci/agent` (multi-stage Dockerfile; `npm run build` emits `dist/index.js` + `dist/users.js`), **`../agent-ui`** → nginx image serving the SPA and proxying `/agent/*` to the app (single origin), **`../agent-cli`** → Node SEA binaries + `install.sh`.
- The CLI renders a compose stack (app, ui, pgvector db, SearXNG) into `~/.agent/runtime/` from `~/.agent/config.json` — there is no user-facing `.env`; all values are concrete at render time.
- Releasing: tag `v*` on a repo → its workflow tests/builds/pushes; then bump that component's tag in `agent-cli`'s `versions.json` on `main` — installs pick it up via `agent update` (CLI self-updates first when `cli` changed; `versions.json` cli must match the CLI tag or its workflow fails).
- `GET /agent/health` (`api/agent/health.ts`, unauthenticated DB ping) backs the container healthcheck and the CLI's readiness wait; `TRANSFORMERS_CACHE` points the embedding-model cache at a volume.
- User accounts on deployments are created via `agent users create` → `docker compose exec app node dist/users.js` (same `scripts/users.ts`, bundled into the image).
- The UI must keep working on insecure origins (`http://<lan-ip>`): no secure-context-only APIs (`crypto.randomUUID` is wrapped in `src/lib/uuid.ts` over there); passkeys are the accepted exception.
- **Tests:** see the Testing section below and [docs/testing.md](docs/testing.md).
- **Auth:** Better Auth (`lib/global/auth.ts`), mounted at `/agent/auth/*` in `index.ts` **before** `express.json()` (it parses its own body). Username+password, TOTP 2FA, and passkeys (plugins: `username`, `twoFactor`, `passkey`). Session cookie identifies the user on every route (`getSessionUser`/`resolveActor` in `lib/agent/actor.ts`); `agent_id` stays an optional param defaulting to the user's oldest agent. Public signup is disabled (`disableSignUp`, gated by `AUTH_SIGNUP=on` — set only by the user CLI and the test server); accounts are created/removed with `npm run users -- create|remove|list` (`scripts/users.ts`). User creation auto-creates a "Personal Assistant" agent (databaseHook). Auth tables live in `lib/global/schema.ts` and must match `getAuthTables(auth.options)` — re-check after adding auth plugins. Requires `BETTER_AUTH_SECRET` and `APP_ORIGIN` in `.env`. Designed for home self-hosting: any private-network origin (RFC 1918 / CGNAT IPs, `.local`/`.lan`/`.ts.net`/`.home.arpa` hosts) is trusted dynamically for CSRF purposes; public origins must be listed in `TRUSTED_ORIGINS`. Passkeys are bound to the `APP_ORIGIN` hostname and need a secure context (HTTPS or localhost).
- Domain logic lives in `lib/`: `lib/db/` (Drizzle queries), `lib/agent/` (memory + web-search tools and prompts), `lib/global/` (db client, AI provider, schema).
- Models are env-configurable: `CHAT_MODEL` (default `google/gemma-4-e4b`, via LM Studio), `EMBEDDING_MODEL` (default `onnx-community/embeddinggemma-300m-ONNX`, a HF id run in-process; 768 dims, must match the `vector(768)` column), `EMBEDDING_DTYPE` (`q8` default; EmbeddingGemma has no fp16). `embedText(value, kind)` applies EmbeddingGemma's task prefixes — callers declare `"query"` or `"document"`. Changing the embedding model/dtype requires `npm run reembed` + recalibrating the relevance floor (`npm run calibrate`, see docs/memory.md). Use `lmstudio.chat(...)` / Chat Completions — LM Studio's `/v1/responses` support is incomplete.
- **Model providers (per user):** Settings → Models in the UI configures LM Studio/Anthropic/Google/DeepInfra credentials (`provider_settings` table — JSONB `settings`, shapes validated in `lib/global/providers.ts`). Saving (`POST /agent/providers`) tests the connection first via each provider's free model-listing endpoint; `POST /agent/provider-test` is the dry-run that feeds the model pickers. API keys never leave the server (GET masks to `hasApiKey`); key-less updates reuse the stored key. The status-bar model selector stores the choice in localStorage and sends `provider`+`model` on each chat request; the conversation route resolves the **sender's** credentials via `chatModelFromSettings` (`lib/global/ai.ts`), falling back to env `CHAT_MODEL` when unset. `/agent/context?provider=&model=` reports provider-aware context windows. Embeddings always run in-process on the env-configured model (768-dim column), regardless of the user's chat provider. Anthropic requests carry two `cacheControl` breakpoints (system block + newest message) for prompt caching — keep them if you restructure the streamText call; LM Studio, Gemini, and DeepInfra cache implicitly by stable prefix.
- The system prompt must stay stable per session (KV-cache reuse); per-turn retrieved memories are appended to the user message as a `<relevant-memories>` block instead. See docs/memory.md before changing prompt assembly.
- **UI (separate repo, `../agent-ui`):** Vite + React 19 + Tailwind 4 + shadcn, streams chat via `@ai-sdk/react`. It strips `<relevant-memories>` blocks when rendering user messages.

## Testing

Vitest, three projects split by determinism (full guide: [docs/testing.md](docs/testing.md)):

- `npm test` — unit + api. Needs only the Postgres container; run this to verify changes. Unit tests mock embeddings with deterministic fake vectors; api tests hit the real server over HTTP on port 3101.
- `npm run test:ai` — RAG ranking (real in-process embeddings, deterministic; no LM Studio) + chat E2E (real model, loose assertions; needs LM Studio, skips itself when it's down). Takes ~2 min.
- `npm run test:all` / `npm run test:watch` — everything / watch mode.

How to use them: after backend changes run `npm test`; after touching retrieval, prompts, or memory phrasing also run `npm run test:ai`. Add tests by dropping `*.test.ts` into `test/unit|api|ai/` — project membership is directory-based. Tests build their own fixtures via `test/helpers/` (`TestClient` cookie-jar fetch, `signUp`, `totpCode`, `readChatStream`, `fakeEmbedding`) and `resetDb()` truncates everything between tests.

Caveats:

- Each project uses its own `agent_test_*` database, never the dev DB; schema is pushed by the global setups. New tables must be added to the truncation list in `test/helpers/db.ts`.
- The api/ai test server is spawned with `NODE_ENV=production` and `TEST`/`VITEST` stripped **on purpose**: Better Auth disables origin/CSRF checks in test environments, which would neuter the security tests. Do not "simplify" this. Its per-IP rate limiter is off via `AUTH_RATE_LIMIT=off`.
- If a run aborts, a stale test server may hold port 3101/3102; the setup refuses to start then — free it with `lsof -ti :3101 | xargs kill`.
- Chat tests in the ai tier may occasionally flake (LLM nondeterminism): rerun once before treating a failure as a regression, and never assert exact model wording.
- A failing `rag.test.ts` floor test usually means the `AUTO_RECALL_MIN_RELEVANCE` calibration drifted (embedding model or phrasing changed): re-measure the relevance bands (see docs/memory.md), don't loosen the test.
