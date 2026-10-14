# Devices

Camera + speaker devices (the rover first; a Pi with a webcam or `scripts/device-sim.ts` work the same way) stream
frames to the backend over one outbound WebSocket each, and a vision model captions them. Captions wake the device's
agent, which keeps the device's conversation, can speak through the device and stores lasting facts, and talks with people
near it in voice mode. The full plan lives in the
rover repo (`rover2/docs/vision-agent-plan.md`).

## Model

- **`devices`**: owner, the agent the device works for (`agent_id`, `NULL` if that agent was deleted; see "Agent
  runs" for the agent registration creates), name, the
  token's SHA-256, a pending pairing code's SHA-256 and expiry (see "Pairing"), settings (JSONB), the last `hello`
  and `telemetry`, `last_seen_at`.
- **`device_observations`**: one row per frame: `seq`, `trigger` (`change` / `heartbeat` / `request`),
  `request_id`, `captured_at` (device clock), `received_at` (server clock), size, and `frame`, the file name on
  disk (`NULL` once retention removed the image). Then the caption: `caption_status`, `caption` (JSON),
  `caption_meta` (provider, model, ms, tokens, error), `captioned_at`, `salience`, and `embedding` (`halfvec(768)`
  of the summary).
- **`device_events`**: connected / disconnected / error, `speech` (what was said or refused, with `status`
  `spoken` / `refused` / `failed`, `source` `agent` / `user`) and `run` (each agent run, with `status`, triggers,
  tools, tokens).
- **`conversations.device_id`**: set on a device's conversation. **`memories.source`**: `chat` or `device`.
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
| `perception.provider`, `perception.model` | `null` | The captioning model, from the owner's providers. `null` provider → the owner's default model; `null` model → the provider's default. An OpenRouter model can pin the provider that serves it: `anthropic/claude-haiku-5.5@google-vertex/europe` (no fallbacks; see "OpenRouter endpoints") |
| `perception.framesPerHour` | 300 | Model calls per rolling hour (captioned + failed) |
| `timezone` | `null` | IANA zone for quiet hours and the times shown to the agent; `null` → the server's |
| `agent.enabled` | `true` | Off: captions never wake the agent |
| `agent.provider`, `agent.model` | `null` | The run's model, resolved like perception's (default: the owner's default model). It also runs the device conversation's compaction, and its memory extraction when the agent has no memory model of its own |
| `agent.salience` | 0.6 | A caption at or above it wakes the agent |
| `agent.minGapSec` | 20 | Runs start at least this far apart; triggers in between merge into the next run |
| `agent.reflectionMin` | 30 | A run that sums up the period, if anything was logged; 0 = off |
| `agent.runsPerHour` | 30 | Runs per rolling hour (done + failed); triggers over it are dropped |
| `speech.muted` | `false` | The mute switch for the agent; the say route still works |
| `speech.provider` | `piper` | Or `openai` (the owner's OpenAI key), or `soniox` (the owner's Soniox key, the same as voice mode's) |
| `speech.model` | `null` | OpenAI or Soniox speech model; `null` → `gpt-4o-mini-tts` / `tts-rt-v2` |
| `speech.language` | `en` | BCP-47, when the agent names none |
| `speech.voices` | `{}` | Voice per language over the built-ins (Piper: `en` lessac, `it` paola; OpenAI: `alloy`; Soniox: `Adrian`, one voice for every language) |
| `speech.cooldownSec` | 60 | Between agent utterances; `urgent` skips it |
| `speech.maxPerHour` | 20 | Agent utterances per rolling hour |
| `speech.quietHours` | 22:00–08:00 | Local, may cross midnight; `null` = never quiet |
| `voice.enabled` | `true` | Off: the device's audio is ignored |
| `voice.provider`, `voice.model` | `null` | The voice turn's model; `null` provider → the agent run's model |
| `voice.languageHints` | `["en", "it"]` | Languages the speech-to-text expects (others are still detected) |
| `voice.endOfTurnMs` | 300 | Silence after the device's last speech segment before the turn is finalised |
| `voice.closeAfterSec` | 45 | The speech-to-text connection closes after this long without speech |
| `tools.disabled` | `[]` | Device tools switched off: any of `speak`, `zoom`, `takePicture`, `searchObservations`. They leave the runs' and voice turns' tool sets, and the rules stop mentioning them |

Settings saved before plan rev 17 had a separate `route` (`{ only, allowFallbacks }`) on each model; reading them
moves its first endpoint into the model id (`readDeviceSettings`), and PATCH no longer takes it.

### OpenRouter endpoints

Any model choice in the app (default model, the chat's, an agent's memory model, a job's, a device job's) can pin
the OpenRouter endpoint that serves it by appending `@<tag>` to the model id, e.g.
`anthropic/claude-haiku-5.5@google-vertex/europe`; the pickers offer the tags from
`GET /agent/provider-endpoints?provider=openrouter&model=` (OpenRouter's `/models/<id>/endpoints`, through the
account's API endpoint, so the EU one lists only EU endpoints). `chatModelFromSettings` and
`buildPerceptionModel` send the bare id with `provider: { only: [tag], allow_fallbacks: false }`, so every call made
with the model (compaction and titles included) stays on that endpoint or fails. The account-wide OpenRouter
settings are only the API endpoint (`region`: global / `eu.openrouter.ai`) and `zdr`.

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
| device → server | `hello` | `version`, `capabilities: { sizes?, audio?, microphone? }`: a camera (the sizes it renders), a speaker (formats it plays), a microphone (formats it streams). Settings → Devices shows the jobs and tools that fit |
| device → server | `telemetry` | `cpuTempC?`, `wifiRssiDbm?`, `uptimeS?` |
| device → server | `frame` (binary) | header `{ type: "frame", seq, capturedAt (epoch ms), trigger, requestId? }`; JPEG payload |
| device → server | `played` | `speechId`, `ok`, `durationMs?`, `error?`: sent when a `speech` message finished playing |
| device → server | `audio` (binary) | header `{ type: "audio", segment, seq, start?, end?, format: "pcm_s16le", sampleRate: 16000 }`; 16 kHz mono PCM while the device's VAD hears speech (with ~300 ms of pre-roll), up to 64 KB a chunk; `start` on a segment's first chunk, `end` on its last (may be empty) |
| server → device | `config` | sent on connect and on every settings change: `paused` and the `cadence` fields |
| server → device | `capture` | `requestId`, `region?` (`{ x, y, w, h }`, 0–1 of the overview). Answer with a `frame`, `trigger: "request"` and the same `requestId`: the overview, or with a region that region at full resolution (not stored, not captioned) |
| server → device | `speech` (binary) | header `{ type: "speech", speechId, format: "wav", sampleRate }`; audio payload. Clips play back to back in arrival order (a voice reply comes sentence by sentence). Answer each with `played` |
| server → device | `stop_speech` | stop playing and drop the queue; answer the dropped clips with `played`, `ok: false` |
| server → device | `error` | `message`; the link stays open |

Close codes: `4000` replaced by a new connection, `4001` token rotated, `4002` device deleted. A device should not
reconnect after these, and should reconnect with backoff after anything else.

## Routes

| Method | Route | Who | Purpose |
|---|---|---|---|
| GET / POST / PATCH / DELETE | `/agent/devices` | session (owner for changes) | List, register (`{ name, description?, agent_id?, memory_pool_id?, timezone? }` → `{ device, agent, token, pairing: { code, expiresAt } }`), rename / describe / move / settings, delete. `description` (≤ 1000 characters; `null` or `""` clears it) is what the device is and what it's for, for agents to read |
| POST | `/agent/devices/token` | owner | Rotate the token (`{ id }` → `{ token }`) |
| POST / DELETE | `/agent/devices/pairing` | owner | A new pairing code (`{ id }` → `{ code, expiresAt }`; an earlier one stops working), or withdraw it (`?id=`) |
| POST | `/agent/devices/pair` | the code | `{ code }` → `{ token, device: { id, name }, ws }`: the device trades the code for a new token (the old one and its link are cut off) |
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
- **The device's conversation:** one continuous conversation per device (plan D24), owned by the device's owner,
  under the device's agent, shared with its members (`conversations.device_id`), compacted as it grows. Runs and
  voice turns take a per-device lock (`lib/devices/lock.ts`; voice turns first), and share the system prompt and
  tools, so the prompt cache carries across both. Each run appends a user message (the
  `<relevant-memories>` block, a `<device-context>` block with the time, the triggers, the captions since the last
  run and recent speech, and the newest frame copied into the log's uploads) and the agent's reply. Frames older
  than the last two runs reach the model as their caption (`windowImageParts`), so the prefix stays cacheable.
- **Tools:** memory tools (stores with `source = "device"`), `speak`, `takePicture` (a fresh frame from the device, downscaled to 1568 px, saved in the conversation's uploads and shown to the model as an image right after the tool's result, through `prepareStep` (`lib/agent/pictures.ts`): OpenAI-compatible providers turn image tool results into JSON text), `zoom` (a full-resolution crop of a region,
  answered by the perception model, kept in the log's uploads), `searchObservations`, `getDate`, notes. No web
  search, connectors or scheduling: the camera is untrusted input. 6 steps at most.
- **Identity:** the camera never identifies anyone. The run's prompt forbids naming people in view, even as one of the
  people the agent serves; names will come only from the face module (plan 4.8).
- **After the run:** the headless compaction check, and memory extraction with the label "`<device> observation`"
  and `DEVICE_MEMORY_EXTRACTION_PROMPT` (the place, routines, animals, known people; never strangers), unless the
  agent has its own extraction prompt.
- **Chats:** any chat gets `searchObservations` over the devices its sender can see, so the Personal Assistant can
  answer "what did the rover see today?". The prompt's "Devices" section lists each of them with its description
  and says to search only for questions about what a device saw or what happened where it is (without it, a chat
  about batteries searched the rover's captions).
- **Description:** the owner's text about what the device is and what it's for. Chats list it (above), and the
  device's own runs get it under "Device runs".

## Voice mode

`lib/devices/voice/` (session, speech to text, text helpers), `lib/agent/voice-turn.ts`. Plan 4.11; phase PV, V1.

- **Listening:** the device sends `audio` while its VAD hears speech. The voice session opens a Soniox real-time
  stream on the first speech (`stt-rt-v5`, speaker labels and language identification on, its endpoint detection off),
  keeps it alive while idle, and closes it after `voice.closeAfterSec` without speech.
- **Soniox key:** the device owner's, stored like a model provider's (Settings → Models → Speech; `provider_settings`
  row `soniox`, tested with Soniox's `GET /v1/models`). It's looked up for each new stream, so a new key applies to the
  next one. `SONIOX_API_KEY` in the environment overrides it (development). Without a key the stream fails with
  `NoSttKeyError`, and the session drops audio for a minute before looking again.
- **End of turn:** `voice.endOfTurnMs` after a segment ends, the session sends `finalize`; the words up to Soniox's
  `<fin>` are the turn, split into lines by voice ("voice 1: …", with the main language). Speech that resumes before
  `<fin>` joins the same turn. (Smart Turn is planned to decide instead of the fixed wait.)
- **The turn:** a `<heard>` user message (day, time, the lines) in the device's conversation, then the reply,
  streamed with the device's system prompt and tools (no `speak`: the reply is spoken). The agent answers when
  addressed, otherwise replies exactly `<silent/>`; the start of the reply is held until it can't be `<silent/>`.
  Each finished sentence is synthesised (Piper) and sent as its own `speech` clip, so the first audio leaves while
  the model still writes. Markup in a reply (a tool call written as text) is never spoken.
- **Barge-in:** 400 ms of new speech while the device plays the reply stops the model and sends `stop_speech`; the
  stored reply keeps the sentences that played, then "[interrupted]".
- **Limits:** a voice reply skips the speech cooldown and hourly cap; mute and quiet hours still apply (the reply is
  stored, not spoken).
- **Log:** a `voice` device event per turn (published live): status (`spoken`, `silent`, `interrupted`,
  `not_spoken`, `failed`), what was heard, the reply, per-clip acks, tokens (cached included) and latencies from the
  end of speech (`final`, `request`, `firstToken`, `firstSentence`, `firstAudio`).
- **Measured (2026-10-13, simulator over Soniox US, Haiku 5.5 on Vertex EU, Piper local):** first audio sent
  1.6–1.7 s after the end of speech with a 500 ms end-of-turn wait (≈ 1.4 s at the 300 ms default); `<silent/>` on
  side talk; Italian answered in Italian; barge-in cut the reply and dropped the queue.

## Speech

`lib/devices/speech.ts`, `speech-policy.ts`, `tts.ts`.

- **Policy** (agent speech only, checked in code before synthesis; a refusal says why): online, not muted, outside
  quiet hours, under the hourly cap, past the cooldown (`urgent` skips only the cooldown). Counts come from the
  speech log.
- **Synthesis:** Piper over HTTP at `PIPER_URL` (`POST /synthesize { text, voice }` → WAV). It is GPL-3.0, so it
  runs as its own container: `docker/piper/Dockerfile` (piper-tts 1.8.0, voices `en_US-lessac-medium` and
  `it_IT-paola-medium`), the `piper` service in `docker-compose.yml` (host port 5050; macOS keeps 5000). Piper falls
  back to its default voice for a voice it doesn't have, silently. Or OpenAI `gpt-4o-mini-tts` with the owner's key.
  Or Soniox (`POST https://tts-rt.soniox.com/tts`, `tts-rt-v2`, WAV at 24 kHz; ~600 voices, each speaking all 63
  languages, so a device keeps one voice across languages). Soniox generates at about real time and the clip is
  sent when complete: measured 2026-10-14 on the simulator, first audio 3.7 s after the end of speech (Piper 1.3 s);
  later sentences are synthesised while earlier ones play.
- **Delivery:** a binary `speech` message; the device answers `played` after playback. No answer within the clip's
  length + 30 s, or a disconnect, is `{ spoken: false }`.

## Retention

`lib/devices/retention.ts` runs at startup and hourly: frames older than `frameDays` are deleted and their rows keep
`frame = NULL`; rows and events older than `observationDays` are deleted. Deleting a device removes its folder.

## Pairing

Settings → Devices (the UI) adds a device and shows a one-time pairing code (`XXXXX-XXXXX`, 31 symbols without
look-alikes, ≈ 50 bits, 30 minutes, `lib/devices/tokens.ts`). On the device, its pairing command posts the code to
`/agent/devices/pair`, which returns the device's token and the link's path; the token never appears on screen or in
a shell history. Case, spaces and dashes in the code don't matter; it works once (cleared in the same update that
sets the token). "Pair again" makes a new code; the device's current token works until it is used. Clients: the
rover service (`sudo rover-agent pair <server> <code>`, rover repo `radxa_software/rover-agent`) and the simulator
(`--server <url> --pair <code>`).

## Simulator

```sh
# Add the device on Settings → Devices and pair it; the token is saved to ~/.config/agent-device-sim/token
npm run device-sim -- --server http://localhost:3001 --pair ABCDE-FGHJK --webcam
npm run device-sim -- --server http://localhost:3001 --mic          # later runs: the saved token
DEVICE_TOKEN=dev_… npm run device-sim -- --dir <folder of JPEGs> [--match 2576x1449] [--interval 2]
DEVICE_TOKEN=dev_… npm run device-sim -- --files empty.jpg,empty.jpg,person.jpg --no-loop --interval 5   # a scripted scene
DEVICE_TOKEN=dev_… npm run device-sim -- --webcam [--camera 0] [--size 1280x720]   # macOS, needs ffmpeg
```

It sends `hello`, telemetry every 30 s and a frame every interval (never faster than `minIntervalMs`), honours
`paused`, answers `capture` requests (a region is cropped from the current frame), plays `speech` with `afplay` and
answers `played`, and reconnects with backoff (1 → 30 s). For speech, run Piper: `docker compose up piper` and
`PIPER_URL=http://localhost:5050`.

Voice: `--speak a.wav,b.wav` streams each file as one stretch of speech in real time (`--interrupt` barges into the
reply), `--mic` uses the Mac's microphone with an energy VAD (half duplex unless `--full-duplex`, with headphones).
Without a frame source the simulator only talks and listens.

## Behind the UI's nginx

A deployment publishes only the UI's port (4125), so devices reach the backend through the UI's nginx.
`agent-ui/nginx.conf` doesn't forward WebSocket upgrades yet (no `Upgrade` / `Connection` headers), so until it does,
devices can only connect to a dev server's port 3001 directly.
