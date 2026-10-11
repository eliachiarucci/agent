# Devices

Camera + speaker devices (the rover first; a Pi with a webcam or `scripts/device-sim.ts` work the same way) stream
frames to the backend over one outbound WebSocket each, and a vision model captions them. Captions wake the device's
agent, which keeps a daily log, can speak through the device and stores lasting facts. The full plan lives in the
rover repo (`rover2/docs/vision-agent-plan.md`).

## Model

- **`devices`**: owner, the agent the device works for (`agent_id`, `NULL` if that agent was deleted; see "Agent
  runs" for the agent registration creates), name, the
  token's SHA-256, settings (JSONB), the last `hello` and `telemetry`, `last_seen_at`.
- **`device_observations`**: one row per frame: `seq`, `trigger` (`change` / `heartbeat` / `request`),
  `request_id`, `captured_at` (device clock), `received_at` (server clock), size, and `frame`, the file name on
  disk (`NULL` once retention removed the image). Then the caption: `caption_status`, `caption` (JSON),
  `caption_meta` (provider, model, ms, tokens, error), `captioned_at`, `salience`, and `embedding` (`halfvec(768)`
  of the summary).
- **`device_events`**: connected / disconnected / error, `speech` (what was said or refused, with `status`
  `spoken` / `refused` / `failed`, `source` `agent` / `user`) and `run` (each agent run, with `status`, triggers,
  tools, tokens).
- **`conversations.device_id`**: set on a device's daily logs. **`memories.source`**: `chat` or `device`.
- **Frames on disk:** `FILES_DIR/devices/<device id>/frames/<uuid>.jpg`, in the volume deployments already mount.
- **Access:** the owner manages the device (settings, token, delete). Members of the device's agent can see it,
  its status and its observations. To anyone else it doesn't exist (404).

## Settings

`lib/devices/settings.ts`. Stored values are always read over the current defaults, so new fields need no data
migration. `PATCH /agent/devices` takes any subset, section by section; a change is pushed to the connected device
as a `config` message.

| Setting | Default | Notes |
|---|---|---|
| `paused` | `false` | Frames are dropped while paused, except answers to `capture` requests |
| `cadence.heartbeatSec` | 60 | A frame at least this often |
| `cadence.minIntervalMs` | 1000 | Minimum gap between change frames |
| `cadence.changeThreshold` | 0.02 | Fraction of the small grayscale frame that must change |
| `cadence.size` | `2576x1449` | Or `1920x1080` |
| `cadence.jpegQuality` | 90 | 50–95 |
| `cadence.fov` | 125 | Diagonal field of view of the corrected view, 60–127° |
| `retention.frameDays` | 7 | Frame images |
| `retention.observationDays` | 90 | Observation rows and device events; frames never outlive their row |
| `perception.enabled` | `true` | Off: frames are stored, never captioned |
| `perception.provider`, `perception.model` | `null` | The captioning model, from the owner's providers. `null` provider → the owner's default model; `null` model → the provider's default |
| `perception.route` | `null` | OpenRouter only: `{ only: ["google-vertex/europe"], allowFallbacks: false }` pins the endpoints that may serve the call |
| `perception.framesPerHour` | 300 | Model calls per rolling hour (captioned + failed) |
| `timezone` | `null` | IANA zone for the daily log, quiet hours and times shown to the agent; `null` → the server's |
| `agent.enabled` | `true` | Off: captions never wake the agent |
| `agent.provider`, `agent.model`, `agent.route` | `null` | The run's model, resolved like perception's (default: the owner's default model); `route` pins OpenRouter endpoints, since the frame goes to this model too |
| `agent.salience` | 0.6 | A caption at or above it wakes the agent |
| `agent.minGapSec` | 20 | Runs start at least this far apart; triggers in between merge into the next run |
| `agent.reflectionMin` | 30 | A run that sums up the period, if anything was logged; 0 = off |
| `agent.runsPerHour` | 30 | Runs per rolling hour (done + failed); triggers over it are dropped |
| `speech.muted` | `false` | The mute switch for the agent; the say route still works |
| `speech.provider` | `piper` | Or `openai` (the owner's OpenAI key) |
| `speech.model` | `null` | OpenAI speech model; `null` → `gpt-4o-mini-tts` |
| `speech.language` | `en` | BCP-47, when the agent names none |
| `speech.voices` | `{}` | Voice per language over the built-ins (Piper: `en` lessac, `it` paola; OpenAI: `alloy`) |
| `speech.cooldownSec` | 60 | Between agent utterances; `urgent` skips it |
| `speech.maxPerHour` | 20 | Agent utterances per rolling hour |
| `speech.quietHours` | 22:00–08:00 | Local, may cross midnight; `null` = never quiet |

## Link

`GET /agent/devices/ws` with `Authorization: Bearer <token>`, upgraded on the `http.Server` in `index.ts`
(`lib/devices/gateway.ts`); the file-based routes can't take upgrades.

- **Tokens:** `dev_` + 32 random bytes (base64url). Shown once, at registration or rotation; only the SHA-256 is
  stored. A missing or wrong token gets HTTP 401 before the upgrade.
- **One connection per device:** a new connection replaces the old one.
- **Liveness:** the server pings every 15 s and drops a connection that missed a whole interval.
- **Limits:** frames up to 8 MB and 4096 px a side, real JPEGs (checked with sharp); 10 frames in a burst, then 4 per
  second per connection. Text messages up to 16 KB.
- **Clock:** a `capturedAt` more than a day from the server's clock is replaced by the arrival time.

Control messages are JSON text. Binary messages are `[u32 big-endian header length][UTF-8 JSON header][payload]`
(`lib/devices/protocol.ts`).

| Direction | Message | Content |
|---|---|---|
| device → server | `hello` | `version`, `capabilities: { sizes?, audio? }` |
| device → server | `telemetry` | `cpuTempC?`, `wifiRssiDbm?`, `uptimeS?` |
| device → server | `frame` (binary) | header `{ type: "frame", seq, capturedAt (epoch ms), trigger, requestId? }`; JPEG payload |
| device → server | `played` | `speechId`, `ok`, `durationMs?`, `error?`: sent when a `speech` message finished playing |
| server → device | `config` | sent on connect and on every settings change: `paused` and the `cadence` fields |
| server → device | `capture` | `requestId`, `region?` (`{ x, y, w, h }`, 0–1 of the overview). Answer with a `frame`, `trigger: "request"` and the same `requestId`: the overview, or with a region that region at full resolution (not stored, not captioned) |
| server → device | `speech` (binary) | header `{ type: "speech", speechId, format: "wav", sampleRate }`; audio payload. Answer with `played` |
| server → device | `stop_speech` | stop playing |
| server → device | `error` | `message`; the link stays open |

Close codes: `4000` replaced by a new connection, `4001` token rotated, `4002` device deleted. A device should not
reconnect after these, and should reconnect with backoff after anything else.

## Routes

| Method | Route | Who | Purpose |
|---|---|---|---|
| GET / POST / PATCH / DELETE | `/agent/devices` | session (owner for changes) | List, register (`{ name, agent_id?, memory_pool_id?, timezone? }` → `{ device, agent, token }`), rename / move / settings, delete |
| POST | `/agent/devices/token` | owner | Rotate the token (`{ id }` → `{ token }`) |
| GET | `/agent/devices/status?id=` | viewer | Online, last seen, hello, telemetry, newest observation and caption, `perception` (model, budget, calls in the last hour) |
| GET | `/agent/devices/observations?device_id=&from=&to=&before=&min_salience=&q=&limit=` | viewer | Timeline, newest first, up to 200 per page. With `q`: semantic search, best match first, each with `relevance` |
| GET | `/agent/devices/frame?id=` | viewer | One observation's JPEG |
| POST | `/agent/devices/say` | viewer | `{ id, text ≤ 300, language? }`: speak now. Only needs the device online (not the agent's limits). 409 when nothing played |
| POST | `/agent/devices/look` | viewer | `{ id, agent = true }`: a fresh frame, captioned ahead of change frames; waits up to 30 s for the caption. Also wakes the agent ("look"). 409 offline, 504 no frame |
| GET | `/agent/devices/live?id=` | viewer | Server-sent events: `status` (first), `observation` (a frame arrived), `caption` (its caption settled), `speech`, `run`, `deleted` |

The status route also reports `agent` (model, runs in the last hour, the last run) and `speech` (muted, provider,
spoken in the last hour, the last utterance).

## Captions

`lib/devices/perception.ts`, one worker per device, one model call at a time.

- **Newest frame wins:** while a call runs, only the newest frame waits; one that is overtaken is `superseded`.
- **The call** (`lib/devices/caption.ts`): `generateText` with `Output.object` and the caption schema (`summary`,
  `changes`, `entities`, `salience`, `wake`, `reason`), the frame and the previous caption. Reasoning is off. The
  OpenAI-compatible providers are built with `supportsStructuredOutputs` so the schema is sent
  (`lib/devices/perception-model.ts`). The prompt tells the model to describe people, never identify them.
- **Statuses:** `NULL` while waiting, then `captioned`, `failed` (error in `caption_meta`), `superseded`,
  `over_budget`, `no_model` (no model resolves) or `disabled`. Only `captioned` and `failed` count towards the budget.
- **Search:** captioned summaries are embedded with EmbeddingGemma (document side) and searched by cosine distance,
  per device, without an ANN index. Half precision keeps 90 days at ~2,000 frames a day to ≈ 280 MB.
- `npm run vision-bench` runs the same call across models (the P0 bench).

## Agent runs

`lib/agent/device-run.ts` (the run), `lib/devices/runner.ts` (scheduling), `lib/devices/run-triggers.ts`.

- **The device's agent:** registering without `agent_id` creates an agent named after the device on the memory pool
  of the user's default agent (the Personal Assistant), or on `memory_pool_id`, with the Personal Assistant's
  members. Deleting the device keeps the agent.
- **Triggers:** a caption with `wake = "agent"`, salience ≥ `agent.salience`, or a new person or animal; a `look`;
  the reflection timer. Runs start at least `minGapSec` apart, one at a time; triggers in between merge.
- **The daily log:** one conversation per device per local day, owned by the device's owner, under the device's
  agent, shared with its members (`conversations.device_id`). Each run appends a user message (the
  `<relevant-memories>` block, a `<device-context>` block with the time, the triggers, the captions since the last
  run and recent speech, and the newest frame copied into the log's uploads) and the agent's reply. Frames older
  than the last two runs reach the model as their caption (`windowImageParts`), so the prefix stays cacheable.
- **Tools:** memory tools (stores with `source = "device"`), `speak`, `zoom` (a full-resolution crop of a region,
  answered by the perception model, kept in the log's uploads), `searchObservations`, `getDate`, notes. No web
  search, connectors or scheduling: the camera is untrusted input. 6 steps at most.
- **Identity:** the camera never identifies anyone. The run's prompt forbids naming people in view, even as one of the
  people the agent serves; names will come only from the face module (plan 4.8).
- **After the run:** the headless compaction check, and memory extraction with the label "`<device> observation`"
  and `DEVICE_MEMORY_EXTRACTION_PROMPT` (the place, routines, animals, known people; never strangers), unless the
  agent has its own extraction prompt.
- **Chats:** any chat gets `searchObservations` over the devices its sender can see, so the Personal Assistant can
  answer "what did the rover see today?".

## Speech

`lib/devices/speech.ts`, `speech-policy.ts`, `tts.ts`.

- **Policy** (agent speech only, checked in code before synthesis; a refusal says why): online, not muted, outside
  quiet hours, under the hourly cap, past the cooldown (`urgent` skips only the cooldown). Counts come from the
  speech log.
- **Synthesis:** Piper over HTTP at `PIPER_URL` (`POST /synthesize { text, voice }` → WAV). It is GPL-3.0, so it
  runs as its own container: `docker/piper/Dockerfile` (piper-tts 1.8.0, voices `en_US-lessac-medium` and
  `it_IT-paola-medium`), the `piper` service in `docker-compose.yml` (host port 5050; macOS keeps 5000). Piper falls
  back to its default voice for a voice it doesn't have, silently. Or OpenAI `gpt-4o-mini-tts` with the owner's key.
- **Delivery:** a binary `speech` message; the device answers `played` after playback. No answer within the clip's
  length + 30 s, or a disconnect, is `{ spoken: false }`.

## Retention

`lib/devices/retention.ts` runs at startup and hourly: frames older than `frameDays` are deleted and their rows keep
`frame = NULL`; rows and events older than `observationDays` are deleted. Deleting a device removes its folder.

## Simulator

```sh
# Register a device (Settings UI later); keep the token from the response.
DEVICE_TOKEN=dev_… npm run device-sim -- --dir <folder of JPEGs> [--match 2576x1449] [--interval 2]
DEVICE_TOKEN=dev_… npm run device-sim -- --files empty.jpg,empty.jpg,person.jpg --no-loop --interval 5   # a scripted scene
DEVICE_TOKEN=dev_… npm run device-sim -- --webcam [--camera 0] [--size 1280x720]   # macOS, needs ffmpeg
```

It sends `hello`, telemetry every 30 s and a frame every interval (never faster than `minIntervalMs`), honours
`paused`, answers `capture` requests (a region is cropped from the current frame), plays `speech` with `afplay` and
answers `played`, and reconnects with backoff (1 → 30 s). For speech, run Piper: `docker compose up piper` and
`PIPER_URL=http://localhost:5050`.

## Behind the UI's nginx

A deployment publishes only the UI's port (4125), so devices reach the backend through the UI's nginx.
`agent-ui/nginx.conf` doesn't forward WebSocket upgrades yet (no `Upgrade` / `Connection` headers), so until it does,
devices can only connect to a dev server's port 3001 directly.
