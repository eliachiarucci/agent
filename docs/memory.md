# Memory System

The agent has a long-term memory: facts about its users (preferences, people, events, health details) stored in Postgres and surfaced to the model on every conversation turn. Storage is one fact per row with an embedding, so memories can be searched semantically (RAG-style) while keeping structured metadata like importance, category, and dates.

## Multi-tenancy

The system is multi-tenant: users own **agents**, and memories live in named **memory pools** (`memory_pools`) decoupled from agents. Each agent points at (at most) one pool via `agents.memory_pool_id`; several agents can point at the same pool and then share every memory, and an agent with no pool attached runs with memory off (no recall, no memory tools, no background extraction). Creating an agent auto-creates a pool named after it, so memory works out of the box. Owners can share an agent with other users (`agent_members`), which grants full access to its pool's memories and shared conversations — sharing an agent means sharing its memory.

- **Pools are the tenancy boundary.** Memories carry a `pool_id` and never cross pools; a freshly created pool knows nothing until told. Pools are owned by the user who created them (`memory_pools.owner_id`), managed in Settings → Memory (`/agent/memory-pools`), and attached to agents in Settings → Agent (`PATCH /agent/agents` with `memory_pool_id`; only the caller's own pools, since attaching exposes the pool to every agent member). Deleting a pool deletes its memories and detaches its agents; deleting an agent leaves its pool (and memories) intact.
- **Attribution inside a shared agent** is two-layered: facts are phrased in third person with names (`"Elia's car is a Golf 7"`, enforced by the tool prompts) *and* carry a structured `subject_user_id` (`NULL` = shared/group fact). Retrieval boosts the speaker's own and shared facts rather than hard-filtering, so "what's Anna's shoe size" still works for Elia.
- **Conversations are private by default** (visible only to their creator). A conversation created with `shared: true` is visible to all agent members, and each user message in it is labeled with the speaker's name when sent to the model (the stored messages stay clean; labels are added deterministically at prompt-build time, so the KV cache stays valid).
- **Speaker identity reaches the model differently per mode:** in a private conversation the system prompt names the single speaker (stable per conversation); in a shared one the system prompt stays speaker-neutral and the per-message labels carry identity.
- **Auth:** the acting user always comes from the Better Auth session cookie (`lib/agent/actor.ts`); `agent_id` stays an optional request param, defaulting to the user's oldest agent. Signing up auto-creates a personal agent.

## Architecture

```
                       ┌──────────────────────────────┐
 user message ──────►  │ POST /agent/conversation     │
                       └──────┬───────────────┬───────┘
        buildMemorySystemPrompt()             │ buildRelevantMemoriesBlock(recent turns)
                              ▼               ▼
                ┌──────────────────────┐  ┌─────────────────────────────┐
                │ system prompt        │  │ user message                │
                │ (stable per session) │  │  <relevant-memories>        │
                │  • pinned memories   │  │   top-4 retrieved memories  │
                │  • memory rules      │  │  </relevant-memories>       │
                └──────────┬───────────┘  │  the user's text            │
                           │              └──────────────┬──────────────┘
                           ▼                             ▼
                       ┌──────────────────────────────┐     remember / updateMemory
                       │ chat model (LM Studio)       │ ──► forget / recallMemories
                       └──────────────────────────────┘     (tool calls, max 8 steps)
```

- **Read path:** before each model call, the recent turns plus the new message are embedded and the top-scoring memories (above a relevance floor) are prepended to the user message as a `<relevant-memories>` block, while every pinned memory sits in the system prompt. The model can also search explicitly mid-conversation with the `recallMemories` tool.
- **Write path:** the model decides what to store. When the user shares a lasting fact, the model calls `remember`; when a fact changes or was wrong, it calls `updateMemory` or `forget` using the memory ids shown in its context. A server-side duplicate guard backs this up: `remember` refuses content that embeds too close to an already-stored memory and returns the existing ids instead (see Agent tools).
- **Background extractor:** a second, dedicated model also writes memories — after every turn, not during it (see Background memory extraction below). The two write paths coexist; the duplicate guard absorbs the overlap.

### Why retrieved memories go in the user message, not the system prompt

The system prompt is the first thing in the serialized prompt, so any per-turn content in it changes the prompt prefix on every message and invalidates the LM Studio (llama.cpp) KV cache, forcing a full reprocess of the whole conversation each turn. Keeping the system prompt stable (rules + pinned memories only) and appending retrieval at the *end* of the message list means each request extends the previous one byte-for-byte, so the server only processes the new tokens. This mirrors how production systems split memory: a session-stable dossier (ChatGPT's "Model Set Context") or pinned core blocks plus tool-based recall (Letta/MemGPT).

Consequences of this design:

- The `<relevant-memories>` block is **persisted in conversation history** (rewriting old messages would also bust the cache). Old blocks reflect what was known at that point; the system prompt tells the model the latest block wins. The UI strips these blocks when displaying user messages (`isVisibleTextPart` in agent-ui's `lib/api.ts`).
- The block is **skipped entirely** when nothing scores above the relevance floor, so unrelated questions don't drag in noise.
- **Caveat:** prefix caching only works for full-attention models. Gemma-family models use interleaved sliding-window attention, for which llama.cpp disables KV cache reuse — with the default `CHAT_MODEL` the layout is still correct (and helps quality via recency placement), but the latency win requires a full-attention model.

## Storage

Memories live in the `memories` table ([lib/global/schema.ts](../lib/global/schema.ts)):

| Column             | Type          | Purpose                                                          |
| ------------------ | ------------- | ---------------------------------------------------------------- |
| `id`               | `uuid` (v7)   | Primary key; shown to the model so it can update/forget facts.   |
| `pool_id`          | `uuid`        | The memory pool this memory belongs to; memories never cross pools. |
| `subject_user_id`  | `uuid?`       | Who the fact is about; `NULL` = shared fact about the group.     |
| `created_by`       | `uuid?`       | Which member stored the fact.                                    |
| `content`          | `text`        | The fact as a short, third-person sentence naming the subject.   |
| `embedding`        | `vector(768)` | pgvector embedding of `content`; HNSW index with cosine ops.     |
| `importance`       | `real` (0–1)  | Retrieval ranking weight, assigned by the model when storing.    |
| `category`         | `text`        | One of `MEMORY_CATEGORIES` (person, family, food, health, …).    |
| `pinned`           | `boolean`     | If true, injected into **every** conversation, bypassing search. |
| `created_at`       | `timestamp`   | When the fact was stored.                                        |
| `last_accessed_at` | `timestamp`   | Touched whenever the memory is retrieved; drives recency.        |

Two deliberate design choices:

- **`pinned` is a flag, not `importance = 1.0`.** Importance is a noisy, continuous score used only for ranking; "inject on every message" is a binary contract. Keeping them separate means a generous importance score can't silently bloat every prompt. Pin sparingly (user's name, severe allergies) — the pinned set is injected wholesale on every turn.
- **Categories are a closed vocabulary.** The allowed values are defined once in `MEMORY_CATEGORIES` and enforced through the zod schemas of the tools and the REST API, so the model can't invent near-duplicate categories (`food` vs `foods` vs `cuisine`).

## Retrieval scoring

`searchMemories` in [lib/db/memories.ts](../lib/db/memories.ts) ranks non-pinned memories with a blended score (the Stanford *Generative Agents* formulation):

```
score = 0.6 × relevance + 0.2 × recency + 0.2 × importance (+ 0.1 × subject-match)
```

- **relevance** — cosine similarity between the query embedding and the memory embedding (`1 - cosine distance`).
- **recency** — exponential decay on `last_accessed_at` with a **7-day half-life**: a memory touched today scores 1.0, a week ago 0.5, two weeks ago 0.25, and so on. Because retrieval touches `last_accessed_at`, frequently used memories stay "warm".
- **importance** — the stored 0–1 score.
- **subject-match** — additive bonus when a `speakerUserId` is passed: memories whose `subject_user_id` is the speaker or `NULL` (shared) get +0.1, so "my car" resolves to the speaker's car while other members' facts stay retrievable on explicit queries. Auto-recall also prefixes the embedded query with the speaker's name (`"Elia: …"`) so the asker's identity reaches the embedding itself.

Weights and half-life are constants at the top of the file (`WEIGHTS`, `RECENCY_HALF_LIFE_SECONDS`) — tune them there. Pinned memories are excluded from search results since they are always in the prompt anyway.

Search accepts an optional `minRelevance` floor applied to the cosine-similarity component alone (before blending), so recency/importance can't surface memories unrelated to the query. Auto-injection uses it (`AUTO_RECALL_MIN_RELEVANCE = 0.48`, limit 4 in [lib/agent/memory.ts](../lib/agent/memory.ts)); the `recallMemories` tool does not, since an explicit search should return its best matches regardless.

The floor is a junk guard, not a precision filter, and it is calibrated for the current embedding regime: EmbeddingGemma's task prefixes (search text embedded as a *query*, memories as *documents* — applied inside `embedText`, call sites just declare the side) plus speaker-prefixed query text (`"Elia: …"`) against third-person memories. Measured bands: unrelated queries ~0.35–0.45, direct hits ~0.53–0.69; `0.48` splits them with margin. Relative *ranking* is reliable (the right memory consistently sorts first); absolute scores are not. `test/ai/rag.test.ts` guards the calibration. If the model, dtype, or phrasing changes, re-measure with `npm run calibrate` (no database needed), update the constant, and **re-embed every stored memory** with `npm run reembed` — old and new vectors are not comparable.

## Duplicate guard

`remember` checks every candidate fact against the memory pool before writing: the content is embedded once, `findSimilarMemories` ([lib/db/memories.ts](../lib/db/memories.ts)) runs a plain cosine search with it (no recency/importance blending, no `last_accessed_at` touch, pinned included), and if anything scores at or above `DUPLICATE_MIN_SIMILARITY` (`0.80`, [lib/agent/memory.ts](../lib/agent/memory.ts)) the insert is skipped. The tool result carries the similar memories' ids and contents plus instructions: update the existing memory if the fact changed, do nothing if it is already stored, or re-call `remember` with `allowDuplicate: true` if it is genuinely distinct. On a clean store the precomputed embedding is reused for the insert, so the check costs one extra SELECT, not a second embed.

This threshold lives in a different regime from the retrieval floor: both sides embed as kind *document*, which yields much higher cosines than query-vs-document. Measured bands (`npm run calibrate`): paraphrases and changed-value contradictions of the same fact ~0.84–0.98, distinct facts — including same-shaped facts about another member ("Elia's car…" vs "Anna's car…" ≈ 0.54) — ~0.54–0.75. `0.80` splits them with margin; `test/ai/rag.test.ts` guards both bands. Recalibrate alongside the retrieval floor whenever the embedding model, dtype, or memory phrasing changes.

## Background memory extraction

The chat model writing its own memories mid-conversation is best-effort — it competes with actually answering the user, and weaker local models often skip it. So a **dedicated extraction model** runs after every turn as a second write path ([lib/agent/memory-extraction.ts](../lib/agent/memory-extraction.ts)). It never talks to the user; its only job is to mine durable facts and operate the memory tools.

- **When it runs:** fire-and-forget from the conversation route's `onFinish` ([api/agent/conversation.ts](../api/agent/conversation.ts)), after the turn is persisted. It is `void`-ed and its errors are swallowed, so a slow or failing extraction never blocks or breaks the chat response.
- **What it sees:** the just-finished exchange — the last user message (machine-inserted `<relevant-memories>`/attachment blocks stripped) plus the complete assistant reply (text parts only) — framed as one `user` turn for the extractor.
- **Memory conversation:** there is one `memory_conversations` row per source conversation (unique on `conversation_id`, cascades on delete). It stores the extractor's running history as **`ModelMessage[]`** (it runs headless via `generateText`, never rendered, unlike `conversations` which keep `UIMessage`s). Each turn appends the new exchange and the extractor's reply — including its memory tool calls and results — so across turns it keeps the context of what it has already stored. The `remember` duplicate guard prevents re-storing the same fact.
- **System prompt** (`MEMORY_EXTRACTION_SYSTEM_PROMPT`): store durable, personal facts (preferences, people, work, places, routines, health, dates); ignore transient/trivial things (one-off lookups, how-tos, copywriting, grammar checks, generated code); phrase third-person with names; `recallMemories` before storing; do nothing when there is nothing to remember.
- **Model:** the agent's configured memory model (`agents.memory_provider` / `memory_model`), owner-picked in **Settings → Agent → Memory model**. It is resolved against the **owner's** provider credentials exactly like a chat request (`resolveMemoryModel`, mirroring cron's `resolveJobModel`), and falls back to the env-configured `CHAT_MODEL` when unset or when that provider has since been deconfigured. Independent of whatever provider/model the turn itself used.
- **Tools:** only `buildMemoryTools(scope)` — the same `remember`/`updateMemory`/`forget`/`recallMemories` the chat model gets, scoped to the same memory pool and attributing `created_by` to the turn's sender.
- **Inspecting them:** read-only via `GET /agent/memory-conversations` (list) and `?id=` (one, with messages flattened to text + tool calls/results). Access mirrors the source conversation — a private chat's memory conversation stays private. Surfaced in the UI behind the Memories dialog's "View memory conversations" (list → conversation, same in-dialog navigation as recurring jobs).
- **Compaction:** the running log grows for the whole life of the source conversation and is re-sent in full each turn, so it is auto-compacted (see below) — destructively, since the durable facts already live in the memory store.

## Auto-compaction

Both the chat history and the memory-extraction log grow without bound, and a long conversation eventually overflows the model's context window. [lib/agent/compaction.ts](../lib/agent/compaction.ts) keeps them inside the window by summarizing the older messages once a usage threshold is crossed. Compaction is a **discrete, occasional event**, not a per-turn re-trim — so the prompt prefix stays byte-stable between events and KV-cache reuse survives (see the caching section above).

- **When it fires:** after the turn's answer, never before it streams. Both paths trigger when `usedTokens > COMPACT_THRESHOLD × contextLength`, using `result.totalUsage` as the turn's true input size; the window comes from `getContextWindow` for the turn's model, falling back to `DEFAULT_CONTEXT_TOKENS` when the provider can't report one.
- **Chat compaction is in-band and visible.** The conversation route streams the answer and the compaction step over **one** `createUIMessageStream`: once the answer finishes, the stream is held open while the summary model runs, so (a) the client stays `status === "streaming"` and the composer is blocked, and (b) a transient `data-compaction` part (`running`/`done`) drives a "Compacting earlier messages…" indicator. The whole decision and summarization stay server-side; the UI only reflects the pushed status. The `consumeSseStream` tee means compaction still completes even if the client disconnects.
- **Memory extraction** checks right after its `generateText` (it's already headless), with no indicator.
- **Safe boundary:** the cut always lands on a `user`-message boundary, so an assistant tool-call is never separated from its tool result (which would make the provider reject the request). The recent tail (~`COMPACT_KEEP_RATIO` of the window) is kept verbatim; the head is summarized by the **same model the conversation runs on** (no tools, one step).
- **Chat is non-destructive:** the full `conversations.messages` history is always kept (scrollback is preserved). Only a `compaction` pointer is stored — `{ summary, throughMessageId, tokens }` — and the model is fed `[summary message, ...messages after throughMessageId]` via `applyCompaction`. The summary rides as a `<conversation-summary>` user message (added to `isMachineTextPart`, so it never gets a speaker label or feeds retrieval). Because compaction completes before the stream closes, the post-turn `refresh()` picks up the new pointer and the UI immediately shows an "Earlier messages summarized for context" divider where the summary ends.
- **Memory extraction is destructive:** the log is rewritten in place to `[summary, ...recent tail]`, because the facts it would protect are already persisted in the memory store and the extractor `recallMemories` before storing anyway.
- **Config:** `COMPACT_THRESHOLD` (default `0.8`), `COMPACT_KEEP_RATIO` (default `0.3`), `DEFAULT_CONTEXT_TOKENS` (default `32768`). Summaries are cumulative — each compaction folds the prior summary into the new one.

## Agent tools

Built per request by `buildMemoryTools(scope)` in [lib/agent/memory.ts](../lib/agent/memory.ts) — the scope (`MemoryScope`) pins the agent, its memory pool, the speaker, and the member list, so every tool call stays inside one pool — and attached to the conversation route with `stopWhen: stepCountIs(8)`:

| Tool             | What it does                                                                  |
| ---------------- | ----------------------------------------------------------------------------- |
| `remember`       | Store a new fact (third-person content, subject, importance, category, optional pinned). The `subject` field is an enum of member names plus `"shared"`, mapped to `subject_user_id` server-side. Near-duplicates are refused: if the content's embedding lands within `DUPLICATE_MIN_SIMILARITY` of a stored memory (pinned included), nothing is written and the tool returns the similar memories' ids + contents so the model can `updateMemory` instead — or retry with `allowDuplicate: true` when the fact is genuinely distinct. |
| `updateMemory`   | Modify an existing memory by id; re-embeds automatically if content changes.  |
| `forget`         | Permanently delete a memory by id.                                            |
| `recallMemories` | Semantic search (optionally filtered by category), returns ids + content; results are subject-boosted for the current speaker. |

Two prompt builders live in the same file:

- `buildMemorySystemPrompt(scope, { sharedConversation })` assembles the stable system prompt: who uses the agent (and who is speaking, in private conversations), pinned memories, and the memory rules (store lasting facts in third person with names, update instead of duplicating, treat `<relevant-memories>` blocks as machine-inserted, don't expose ids to the user). It takes no per-turn input by design — see the caching section above.
- `buildRelevantMemoriesBlock(scope, queryText)` runs the scored search (top 4 above the relevance floor, speaker-prefixed query, subject boost) and returns the `<relevant-memories>` block prepended to the user message, or `null` when nothing relevant is found. Each memory is formatted with its id, category, and date so the model can reference them in tool calls. The query is built in [api/agent/conversation.ts](../api/agent/conversation.ts) from the last few turns plus the new message, so short follow-ups ("what about her birthday?") still retrieve well.

## REST API

[api/agent/memory.ts](../api/agent/memory.ts) exposes memories for inspection and manual management. Embedding vectors are stripped from all responses. All routes require a session and scope to a pool: pass `pool_id` directly (the caller must own the pool or be a member of an agent attached to it), or `agent_id` to use that agent's attached pool (default: the user's oldest agent; the user must be a member). A `GET` through an agent with no pool returns `[]`; writes through one are rejected.

| Method   | Route                | Notes                                                                                     |
| -------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `GET`    | `/agent/memory`      | List (newest first). Query params: `category`, `pinned`, `limit`.                          |
| `GET`    | `/agent/memory?q=…`  | Substring browse filter; same `category`/`limit` params.                                   |
| `POST`   | `/agent/memory`      | Body: `{ content, importance, category, pinned?, subject_user_id? }` (`null` = shared fact; defaults to the acting user). Embeds and stores. |
| `PATCH`  | `/agent/memory`      | Body: `{ id, ...changes }`. Re-embeds if `content` changes.                                |
| `DELETE` | `/agent/memory?id=…` | Deletes the memory.                                                                        |

Memory pools have their own routes ([api/agent/memory-pools.ts](../api/agent/memory-pools.ts)): `GET /agent/memory-pools` lists the caller's pools with memory counts and attached agents, `POST` creates one (`{ name }`), `DELETE ?id=` removes it (owner-only; cascades to its memories, detaches its agents).

Agent and account management live in their own routes: `/agent/users` (GET/POST), `/agent/agents` (GET/POST/PATCH/DELETE, owner-only mutations), `/agent/members` (GET/POST/DELETE — sharing; owner-only adds, members can remove themselves). `/agent/conversation` accepts `agent_id`, `user_id`, and `shared` (creation only) and scopes GET/DELETE to what the user may see.

Example:

```bash
curl 'http://localhost:3001/agent/memory?q=what%20food%20does%20he%20like'
```

## Models and configuration

The chat model is served by LM Studio (`http://localhost:1234/v1`); embeddings run **in-process** via transformers.js (ONNX on CPU) so memory works without LM Studio. Both are configured in [lib/global/ai.ts](../lib/global/ai.ts):

| Env var           | Default                                  | Used for                       |
| ----------------- | ---------------------------------------- | ------------------------------ |
| `CHAT_MODEL`      | `google/gemma-4-e4b`                     | Conversation + memory tools.   |
| `EMBEDDING_MODEL` | `onnx-community/embeddinggemma-300m-ONNX` | Embedding memories and queries (Hugging Face model id; downloaded and cached on first use, ~300MB). |
| `EMBEDDING_DTYPE` | `q8`                                     | Embedding quantization: `fp32`, `q8`, or `q4` (EmbeddingGemma does not support fp16). q8 keeps the model under ~350MB resident for a ~0.3–1.0 MTEB-point cost. |
| `TRANSFORMERS_CACHE` | transformers.js default (inside `node_modules`) | Where downloaded model files are cached. Point it at a mounted volume in containers so the model survives recreation. |

Constraints to keep in mind:

- The embedding model's output dimensions must match the `vector(768)` column. Switching models keeps the schema only if the new model also emits 768 dims (EmbeddingGemma does natively) — and **always requires `npm run reembed` plus recalibrating the relevance floor** (see above).
- EmbeddingGemma is multilingual (~100 languages): an Italian query retrieves an English-phrased memory and vice versa — `test/ai/rag.test.ts` covers this.
- The server warms the embedder at boot (`preloadEmbedder()`); the first request after a cold start on a fresh machine may still wait on the model download.
- The chat model is called through `lmstudio.chat(...)` deliberately: the provider's default targets OpenAI's Responses API (`/v1/responses`), which LM Studio implements only partially — multi-step tool calls fail there. `.chat()` forces the Chat Completions API, which works.

## Database setup

pgvector is required. The compose file uses the `pgvector/pgvector:pg18` image, and [docker/init.sql](../docker/init.sql) runs `CREATE EXTENSION IF NOT EXISTS vector` automatically on **fresh** volumes. For a pre-existing volume, enable it once by hand, then push the schema:

```bash
docker compose exec db psql -U postgres -d agent -c 'CREATE EXTENSION IF NOT EXISTS vector;'
npm run db:push
```
