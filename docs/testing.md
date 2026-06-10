# Testing

The backend is tested with [Vitest](https://vitest.dev), split into **three projects** that differ in determinism, dependencies, and speed. The split exists because "does the subject boost order rows correctly" and "does the LLM answer with the right car" are very different kinds of claims, and mixing them produces suites that are either slow or flaky.

| Project | What it covers | Determinism | Needs | Typical duration |
| ------- | -------------- | ----------- | ----- | ---------------- |
| `unit`  | `lib/db` + `lib/agent` logic: retrieval scoring blend, subject boost, agent scoping, pinned handling, membership rules, conversation visibility predicates | Fully deterministic (embeddings mocked) | Postgres | ~2 s |
| `api`   | The real server over HTTP: signup/login/2FA, CSRF origin policy, sharing, access control on conversations and memories | Fully deterministic | Postgres | ~5 s |
| `ai`    | RAG ranking with real embeddings; full chat turns through the real model | Embeddings deterministic; chat is not | Postgres (+ LM Studio for the chat suite) | ~1–2 min |

## Running

```bash
npm test          # unit + api — the default check after backend changes
npm run test:ai   # the model-dependent tier (skips itself if LM Studio is down)
npm run test:all  # everything
npm run test:watch
```

Prerequisites: the dev Postgres container (`docker compose up -d db`). Embeddings run in-process (EmbeddingGemma via transformers.js), so the RAG suite needs no LM Studio — only a one-time ~300MB model download on the very first run. For the chat suite in `test:ai`, LM Studio on `localhost:1234` with the chat model loaded — when it isn't reachable, the chat suite **skips** rather than fails, so `test:all` is always safe to run.

Single file / single test:

```bash
npx vitest run --project api test/api/sharing.test.ts
npx vitest run --project unit -t "subject boost"
```

## Architecture

```
test/
  config.ts           ports, db names, LM Studio probe — shared constants
  setup/
    database.ts       create db if missing + pgvector + drizzle-kit push
    server.ts         esbuild the real server, spawn it, health-check it
  global/
    unit.ts api.ts ai.ts    per-project global setup/teardown
  helpers/
    db.ts             resetDb(), makeUser(), makeUserWithAgent()
    client.ts         TestClient — fetch with a cookie jar
    auth.ts           signUp(), signIn(), TEST_PASSWORD
    totp.ts           RFC 6238 code generator
    sse.ts            readChatStream() → { text, toolCalls, events }
    embeddings.ts     fakeEmbedding(seed) — deterministic 768-dim vectors
  unit/ api/ ai/      the suites; project membership is directory-based
```

### Databases

Each project owns a database (`agent_test_unit`, `agent_test_api`, `agent_test_ai`) on the same Postgres container as dev. The global setup creates it if missing, enables pgvector, and syncs the schema with `drizzle-kit push` (idempotent). Projects can therefore run concurrently; **files within a project run sequentially** (`fileParallelism: false`) because every test starts with `resetDb()`, which truncates all tables. Tests never touch the dev database: `DATABASE_URL` is injected per project by `vitest.config.ts`.

The consequence to remember: **tests own their fixtures.** Nothing depends on seed data, other tests, or execution order. Helpers make a fresh world cheap — `signUp(client, "Elia")` for real accounts through Better Auth, `makeUserWithAgent("Owner", [member])` for direct rows in unit tests.

### The server under test

The api and ai projects build the actual server — same esbuild pipeline as dev, including the virtual `api-routes` module — and spawn it as a child process on port **3101** (api) / **3102** (ai), pointed at the project's database. Testing over real HTTP is deliberate: it covers Better Auth's cookie handling, the auth handler mounted *before* `express.json()`, SSE streaming, and the exact 401/403 behavior the UI sees.

Two environment details are load-bearing (both were found the hard way):

1. **Better Auth disables its own security in test environments.** Its `isTest()` returns true when `NODE_ENV=test` *or* `TEST=true` — and Vitest exports both into its process. A naively spawned server inherits them and silently skips all origin/CSRF checks, making the security tests pass against nothing. The spawner therefore forces `NODE_ENV=production` and strips `TEST`/`VITEST` from the child env. Two production behaviors are turned off: the per-IP rate limiter (`AUTH_RATE_LIMIT=off`), since every test request comes from 127.0.0.1, and the signup lockout (`AUTH_SIGNUP=on`), since fixtures are built through real sign-ups over HTTP — in production, signup is disabled and accounts come from the CLI (`npm run users`).
2. **Stale servers are refused, not reused.** If an interrupted run leaves an old server holding the port, it would answer the health check and serve the whole suite with outdated code. The spawner fails fast with instructions (`lsof -ti :3101 | xargs kill`), and double-checks that its own child is still alive after the health probe (a child that lost the port race dies of `EADDRINUSE` while the orphan answers).

### Fake embeddings (unit tier)

`fakeEmbedding(seed)` produces deterministic 768-dim unit vectors: the same seed always yields the same vector (cosine = 1), different seeds are near-orthogonal in 768 dimensions (cosine ≈ 0). Unit tests mock `lib/global/ai`'s `embedText` with a per-test map, which lets them *script relevance exactly* — e.g. give all three car-related memories and the query the same vector so every score component ties, then assert that the subject bonus alone decides the ranking.

### The AI tier

Two suites, different rules:

- **`rag.test.ts` — deterministic.** Real EmbeddingGemma embeddings, in-process — no LM Studio. Embeddings for fixed text are stable, so ranking assertions ("Elia asking *my car* gets the Golf first, Anna gets the Panda", an Italian query finding an English memory) hold reliably. This suite also **guards the `AUTO_RECALL_MIN_RELEVANCE` calibration** (unrelated ~0.35–0.45, direct hits ~0.53–0.69 — measured with `npm run calibrate`; see docs/memory.md). If the floor test fails after changing the embedding model, dtype, or phrasing, *re-measure the bands and recalibrate the constant* — don't loosen the assertion. It exists precisely to catch silent drift here.
- **`chat.test.ts` — non-deterministic.** Full turns through the chat model, asserting loosely: case-insensitive substrings (`/golf/i`), tool-call names from the stream, or stored side effects (a memory containing "espresso" exists afterwards). Exact wording is never a contract. Occasional flakes are the accepted price; rerun once before treating a failure as a regression. This is also why the tier is opt-in rather than part of `npm test`.

## Writing new tests

1. Drop a `*.test.ts` file in `test/unit/`, `test/api/`, or `test/ai/` — directory = project.
2. Start with `beforeEach(resetDb)` and `afterAll(closeDb)` (the latter closes the worker's pg pool so Vitest exits cleanly).
3. Build fixtures through the helpers; one `TestClient` per simulated user/device — each has its own cookie jar, so multi-user scenarios are just multiple clients.
4. API-tier tests must not require LM Studio. Two patterns make that possible: seed conversations/memories directly in the database (with `fakeEmbedding` vectors) instead of chatting, and rely on access checks running *before* any model call (e.g. a 403 on `POST /agent/conversation` is testable without a model).
5. If a schema change adds tables, update the truncation list in `test/helpers/db.ts` — and for new Better Auth plugin tables, keep `lib/global/schema.ts` in sync with `getAuthTables(auth.options)`.

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| `Port 3101 is already in use (stale test server?)` | An aborted run left a server behind: `lsof -ti :3101 \| xargs kill` (3102 for the ai tier). |
| Everything fails with connection errors | Postgres isn't up: `docker compose up -d db`. |
| Chat suite skips | LM Studio isn't reachable on `localhost:1234` — that's the intended behavior, not an error. The RAG suite runs regardless (in-process embeddings). |
| One chat test failed, reruns pass | LLM nondeterminism; acceptable in the ai tier. If it fails consistently, treat it as real. |
| `drizzle-kit push failed for agent_test_*` | Schema conflict in the test DB (e.g. after switching branches). Drop the database — it's recreated on the next run: `docker exec agent-db-1 psql -U postgres -c 'drop database agent_test_api'`. |
| Origin tests fail after touching auth config | Check you didn't reintroduce Vitest's `TEST`/`NODE_ENV` into the spawned server env (see "server under test" above). |

## Known gaps

- **Passkeys/WebAuthn** can't be exercised over plain fetch — they need a browser. The plan is a Playwright E2E layer with a CDP virtual authenticator (also covering the login page, agent switcher, and shared-conversation toggle in the UI repo).
- The UI repo (`../agent-ui`) currently has no test suite of its own.
