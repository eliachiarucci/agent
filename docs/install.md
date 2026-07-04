# Installation, deployment & operations

This document covers how the self-hosted stack is installed, how it runs, how updates
and releases work, and how to troubleshoot it. For the memory system see
[memory.md](memory.md); for tests see [testing.md](testing.md).

## Quick start (end users)

```sh
curl -fsSL https://raw.githubusercontent.com/eliachiarucci/agent-cli/main/install.sh | bash
```

One command on a fresh machine does everything:

1. Downloads the `agent` CLI binary for your platform (macOS Apple Silicon, Linux
   x64/arm64) from GitHub releases, verifies its checksum, and installs it to
   `/usr/local/bin` (or `~/.local/bin` without sudo).
2. Runs `agent setup`, which checks for Docker — on Linux it offers to install it via
   get.docker.com and handles the docker-group dance; on macOS it starts
   OrbStack/Docker Desktop or tells you how to get one.
3. Asks two questions: the port (default 4125) and the address other devices will use
   (defaults to your `.local` hostname or LAN IP).
4. Pulls the images, starts the stack, waits until it's healthy.
5. Prompts you to create the first user account in the terminal.
6. Prints the web UI URL.

After that, open the URL, log in, and configure a chat provider under
**Settings → Models** (Anthropic API key or an LM Studio URL). No LLM configuration is
needed at install time: chat providers are per-user dashboard settings, and memory
embeddings run in-process on CPU (the ~300 MB model downloads automatically on first
boot).

**Requirements:** macOS (Apple Silicon) or Linux (x64/arm64), ~2 GB free disk for the
images plus the embedding model, and a terminal. Docker is installed for you if missing.

### Exposing it beyond localhost

The stack serves **plain HTTP**, which is fine on a trusted LAN but has two consequences:

- **Passkeys don't work** over insecure origins (WebAuthn needs HTTPS or localhost).
  Password + TOTP login works everywhere.
- On a **public VPS**, credentials would travel in cleartext. Put TLS in front
  (e.g. `caddy reverse-proxy --from agent.example.com --to localhost:4125`) and run
  `agent config set appOrigin https://agent.example.com`, or use Tailscale and the
  `.ts.net` hostname (auto-trusted by the backend) without opening any public port.

The backend dynamically trusts private-network origins (RFC 1918 IPs, `.local`, `.lan`,
`.ts.net`, `.home.arpa`) for CSRF, so LAN access needs no extra configuration.

## The `agent` CLI

```
agent setup                      Install and start everything (idempotent)
agent start | stop | restart     Manage the stack
agent status                     Containers, versions, health
agent logs [service] [-f]        Tail logs (app, ui, db, searxng)
agent users list                 List accounts
agent users create <username> [--name "Full Name"]
agent users remove <username>
agent config get [key]           Show configuration
agent config set <key> <value>   port, appOrigin, startWebUi
agent backup [path] [--files]    Dump the database (and, with --files, agent-created files)
agent update                     Update CLI, images, and database schema
agent self-update                Update only the CLI binary
agent uninstall                  Remove the stack (data wiped only on typed confirm)
```

Users never run docker commands; the CLI wraps them. Public signup is disabled in the
backend — `agent users create` (which runs the bundled `dist/users.js` inside the app
container over an interactive TTY) is the only way accounts are created.

### Configuration

`~/.agent/config.json` is the single source of truth — there is no user-facing `.env`:

```jsonc
{
  "version": 1,
  "release": "v0.1.0",        // backend image tag currently deployed
  "uiTag": "v0.1.2",          // UI image tag currently deployed
  "port": 4125,               // the only published port
  "appOrigin": "http://myserver.local:4125",
  "startWebUi": true,         // false = publish the API port directly, no UI container
  "secrets": { /* generated once at setup: auth secret, db password, searxng key */ }
}
```

Before every operation the CLI renders concrete runtime artifacts from it into
`~/.agent/runtime/`: `docker-compose.yml`, `app.env`, and `searxng/settings.yml`.
These files are overwritten on each render — change settings only via
`agent config set`, then `agent restart`.

Changing `appOrigin` to a different hostname invalidates existing passkeys (WebAuthn
binds credentials to the hostname); the CLI warns when it applies.

## Architecture

Three repositories, three release artifacts, orchestrated by Docker Compose on the
user's machine:

| Repo | Artifact | Role |
|---|---|---|
| `agent` (this one) | `ghcr.io/eliachiarucci/agent` | Express API, memory/RAG, auth, migrations |
| `agent-ui` | `ghcr.io/eliachiarucci/agent-ui` | nginx serving the built SPA **and** reverse-proxying `/agent/*` to the app |
| `agent-cli` | `agent` SEA binaries + `install.sh` | installer, orchestrator, updater |

The rendered compose stack:

```
browser ──:4125──▶ ui (nginx) ──/agent/*──▶ app (node :3001) ──▶ db (pgvector, internal)
                       │ static SPA                 │
                       └────────────────────────────┴──▶ searxng (web search, internal)
```

Key properties:

- **Single origin.** The UI proxies the API, so Better Auth cookies, CSRF, and passkeys
  need no cross-origin setup. `proxy_buffering off` keeps chat token streaming
  incremental. With `startWebUi=false` the app port is published directly instead and
  you bring your own frontend.
- **Minimal surface.** Only the UI port is published. Postgres and SearXNG are reachable
  exclusively on the compose network; the database password and the SearXNG secret are
  generated per install.
- **Self-migrating.** The app image ships the committed `drizzle/` migrations and applies
  them at startup when `MIGRATE=on` (which the rendered env always sets). First boot
  creates the schema; updates apply whatever is pending; an up-to-date schema is a no-op.
- **Stateful volumes.** `pgdata` (database) and `models` (embedding model cache via
  `TRANSFORMERS_CACHE=/models`) survive image updates. `agent uninstall` keeps them
  unless you explicitly type `delete`.
- **Host reachability.** The app container gets `host.docker.internal` mapped to the
  host gateway, so a dashboard-configured LM Studio running on the same machine is
  reachable as `http://host.docker.internal:1234` (LM Studio must listen on the network,
  not just loopback).
- **Health.** `GET /agent/health` (unauthenticated DB ping) backs the container
  healthcheck and the CLI's readiness wait, and works both through the proxy and inside
  the container.

## Updates

`agent update` drives everything from `versions.json` on the agent-cli repo's `main`
branch, which pins the released trio:

```json
{ "cli": "v0.1.2", "backend": "v0.1.0", "ui": "v0.1.2" }
```

The update sequence:

1. Fetch the manifest.
2. If `cli` is newer than the running binary: download the new binary from GitHub
   releases, verify the SHA-256, replace itself in place, and re-exec — so a new compose
   template always ships before the images that rely on it.
3. Re-render the compose files with the new image tags, `docker compose pull`,
   `up -d --remove-orphans`, and wait for health. Migrations run automatically inside
   the new app container.
4. Only after the new images are running are the versions recorded in config — a failed
   update stays retryable.
5. Once the stack is healthy, the previous backend/UI image tags are removed
   (best-effort) so updates don't accumulate old images on disk.

## Backups

Two ways to take one, same artifact (a `pg_dump --format=custom` archive, restorable
with `pg_restore`):

- **`agent backup [path] [--files]`** — runs pg_dump inside the db container (so
  versions always match) and writes `agent-backup-YYYY-MM-DD.dump` to the current
  directory or the given path. `--files` additionally archives agent-created files
  (the `files` volume, `FILES_DIR`) to `agent-files-YYYY-MM-DD.tar.gz` — those live
  outside the database, so grab them too for a complete backup. Cron-friendly.
- **Settings → General → Download backup** — `GET /agent/backup`; the app image ships
  `postgresql-client-18` for this (keep its major version ≥ the `pgvector/pgvector`
  image's).

The dump contains every user's data, including provider API keys and connector tokens,
and any signed-in user can take one from the UI — hand out accounts accordingly.

Restoring is a host-side operation, never an upload:

```sh
agent stop
docker compose -f ~/.agent/runtime/docker-compose.yml up -d db
docker compose -f ~/.agent/runtime/docker-compose.yml exec -T db \
  sh -c 'dropdb -U agent --if-exists agent && createdb -U agent agent &&
         pg_restore -U agent -d agent --no-owner' < agent-backup-YYYY-MM-DD.dump
agent start
```

A `--files` archive is restored into the running app container:

```sh
docker compose -f ~/.agent/runtime/docker-compose.yml exec -T app \
  tar -xzf - -C /files < agent-files-YYYY-MM-DD.tar.gz
```

Restoring an **older** backup into a **newer** release is supported: the dump carries
the Drizzle migrations journal, so the app applies the missing migrations at startup
(`MIGRATE=on`). The reverse — a newer dump into an older release — is not: the schema
would be ahead of what the code expects. If the backup predates a change of
`EMBEDDING_MODEL`/`EMBEDDING_DTYPE`, run `npm run reembed` afterwards (docs/memory.md).

## Releasing (maintainers)

All three repos release by pushing a `v*` tag; GitHub Actions does the rest. GHCR
packages must be **public** (GitHub defaults them to private on first push — flip it
once in the package settings, or every install fails to pull).

- **Backend** (`agent`): tag → CI runs `npm test` and the migration drift guard
  (`drizzle-kit generate` must produce no diff), then builds the multi-arch image.
  Every schema change must ship a committed migration: `npx drizzle-kit generate`,
  commit `drizzle/`.
- **UI** (`agent-ui`): tag → CI builds the multi-arch nginx image. The release tag is
  baked into the bundle via the `APP_VERSION` build arg and shown in
  **Settings → General**.
- **CLI** (`agent-cli`): bump `cli` in `versions.json` to the new tag (the workflow
  fails on mismatch), tag → CI builds the SEA binaries on ubuntu-24.04 / ubuntu-24.04-arm /
  macos-14 and creates the GitHub release that `install.sh` and `self-update` download.

**Rolling out** a backend/UI release to installs is a separate, deliberate step: bump
`backend`/`ui` in `versions.json` on agent-cli `main`. No CLI release is needed for
image-only rollouts.

## Local development of the deployment pieces

Build dev images and run the whole flow without touching GHCR or releases:

```sh
# backend repo                      # UI repo
docker build -t ghcr.io/eliachiarucci/agent:dev .
docker build -t ghcr.io/eliachiarucci/agent-ui:dev .

# CLI repo — run from source against the dev images, isolated config dir
AGENT_IMAGE=ghcr.io/eliachiarucci/agent:dev \
AGENT_UI_IMAGE=ghcr.io/eliachiarucci/agent-ui:dev \
AGENT_HOME=/tmp/agent-test npm run dev -- setup
```

Note the rendered compose project is named `agent` and collides with this repo's dev
compose project — stop one before starting the other (`docker compose down`).

## Troubleshooting

- **Install "stuck" at downloading** — the binary is ~120 MB; older install.sh versions
  downloaded silently. Current versions show a progress bar.
- **`permission denied … runtime/searxng/settings.yml` during update/restart** — the
  SearXNG container chowns its bind-mounted config dir on startup; CLI ≥ v0.1.2 handles
  this (the file never changes after install). On older CLIs:
  `sudo chown -R $USER ~/.agent/runtime/searxng && agent restart`, then `agent self-update`.
- **Black screen after login, `crypto.randomUUID is not a function`** — UI < v0.1.2 on a
  plain-HTTP origin; `agent update` (browsers only expose that API in secure contexts;
  the UI now ships a fallback).
- **`compose pull` fails with an auth error** — the GHCR package is still private.
- **Stack up but chat errors** — no provider configured yet: Settings → Models. For a
  same-host LM Studio, use `http://host.docker.internal:1234` and enable "serve on
  network" in LM Studio.
- **First reply slow after install** — the embedding model (~300 MB) downloads on first
  boot; watch it with `agent logs app -f`.
- **Moving an existing pre-CLI deployment** (a dev checkout whose DB was created with
  `db:push`): the schema has no migrations journal, so `MIGRATE=on` fails against it.
  Do a fresh install and restore a `pg_dump` of the old database into the new `db`
  container, or baseline the journal by hand.
- **Postgres major upgrades**: the data volume is built by `pgvector/pgvector:pg18`;
  never bump that image's major version without a dump/restore plan.
