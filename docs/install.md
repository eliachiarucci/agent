# Installation & deployment

End users install the stack with one command (see the [agent-cli repo](https://github.com/eliachiarucci/agent-cli)):

```sh
curl -fsSL https://raw.githubusercontent.com/eliachiarucci/agent-cli/main/install.sh | bash
```

The CLI checks/installs Docker, writes `~/.agent/config.json`, renders a compose stack
(app, web UI, Postgres + pgvector, SearXNG), starts it, prompts for the first user, and
prints the web UI URL. Requirements: macOS (Apple Silicon) or Linux (x64/arm64) with
~2 GB free disk. No LLM setup is needed at install time — chat providers are configured
per user in the dashboard, and memory embeddings run in-process (the ~300 MB model
downloads on first boot into a Docker volume).

## How a deployment differs from dev

| | Dev (this repo) | Deployed (CLI-rendered) |
|---|---|---|
| Images | `docker compose up -d db` + `npm run dev` on host | `ghcr.io/eliachiarucci/agent` + `agent-ui` |
| Schema | `npm run db:push` | committed migrations in `drizzle/`, run at startup (`MIGRATE=on`) |
| Config | `.env` | `~/.agent/config.json` → rendered `app.env` (never hand-edited) |
| Origin | Vite dev server :5173 | nginx in the UI image serves the SPA and proxies `/agent/*` to the app — single origin |
| DB/SearXNG ports | published for dev tooling | not published |

## Migrations

- `drizzle/` is generated with `npx drizzle-kit generate` and **must be committed with any
  schema change** — the release workflow fails on drift.
- The app runs `migrate()` at startup only when `MIGRATE=on` (set by the CLI's rendered
  env). Dev and test databases stay on `drizzle-kit push`; never set `MIGRATE=on` there —
  `migrate()` fails on tables that were created by push (no migrations journal).
- Migrating an existing push-managed deployment to the containerized stack requires a
  one-time baseline (or a fresh install plus data dump/restore); it is not automated.

## Releases

1. **Backend**: tag `v*` here → CI runs tests + the migration drift guard, then pushes a
   multi-arch image to GHCR.
2. **UI**: tag `v*` in `agent-ui` → CI pushes its image.
3. **Rollout**: bump `backend`/`ui` in `versions.json` on `agent-cli` `main`. Installs
   pick it up via `agent update` (CLI self-updates first when `cli` changed too).

GHCR packages must be public (GitHub defaults them to private on first push).

## Operational notes

- **Health**: `GET /agent/health` (unauthenticated, checks DB connectivity) is used by the
  container healthcheck and the CLI's readiness wait.
- **Passkeys** bind to the `appOrigin` hostname; the CLI warns when it changes.
- **Postgres major versions**: the data volume is tied to pg18 — bumping the
  `pgvector/pgvector` image major requires a dump/restore path, so keep it pinned until
  that ships.
- **Model cache**: the embedding model lives in the `models` volume
  (`TRANSFORMERS_CACHE=/models`); wiping it just re-downloads on next boot.
