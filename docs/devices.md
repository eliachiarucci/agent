# Devices

Camera + speaker devices (the rover first; a Pi with a webcam or `scripts/device-sim.ts` work the same way) stream
frames to the backend over one outbound WebSocket each. This is the foundation of the vision agent: captions,
agent runs and speech build on it. The full plan lives in the rover repo (`rover2/docs/vision-agent-plan.md`).

## Model

- **`devices`**: owner, the agent the device works for (`agent_id`, `NULL` if that agent was deleted), name, the
  token's SHA-256, settings (JSONB), the last `hello` and `telemetry`, `last_seen_at`.
- **`device_observations`**: one row per frame: `seq`, `trigger` (`change` / `heartbeat` / `request`),
  `request_id`, `captured_at` (device clock), `received_at` (server clock), size, and `frame`, the file name on
  disk (`NULL` once retention removed the image).
- **`device_events`**: connected / disconnected / error.
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
| server → device | `config` | sent on connect and on every settings change: `paused` and the `cadence` fields |
| server → device | `error` | `message`; the link stays open |

Close codes: `4000` replaced by a new connection, `4001` token rotated, `4002` device deleted. A device should not
reconnect after these, and should reconnect with backoff after anything else.

## Routes

| Method | Route | Who | Purpose |
|---|---|---|---|
| GET / POST / PATCH / DELETE | `/agent/devices` | session (owner for changes) | List, register (`{ name, agent_id? }` → `{ device, token }`), rename / move / settings, delete |
| POST | `/agent/devices/token` | owner | Rotate the token (`{ id }` → `{ token }`) |
| GET | `/agent/devices/status?id=` | viewer | Online, last seen, hello, telemetry, newest observation |
| GET | `/agent/devices/observations?device_id=&from=&to=&before=&limit=` | viewer | Timeline, newest first, up to 200 per page |
| GET | `/agent/devices/frame?id=` | viewer | One observation's JPEG |

## Retention

`lib/devices/retention.ts` runs at startup and hourly: frames older than `frameDays` are deleted and their rows keep
`frame = NULL`; rows and events older than `observationDays` are deleted. Deleting a device removes its folder.

## Simulator

```sh
# Register a device (Settings UI later); keep the token from the response.
DEVICE_TOKEN=dev_… npm run device-sim -- --dir <folder of JPEGs> [--match 2576x1449] [--interval 2]
DEVICE_TOKEN=dev_… npm run device-sim -- --webcam [--camera 0] [--size 1280x720]   # macOS, needs ffmpeg
```

It sends `hello`, telemetry every 30 s and a frame every interval (never faster than `minIntervalMs`), honours
`paused`, answers `capture` requests, plays `speech` with `afplay`, and reconnects with backoff (1 → 30 s).

## Behind the UI's nginx

A deployment publishes only the UI's port (4125), so devices reach the backend through the UI's nginx.
`agent-ui/nginx.conf` doesn't forward WebSocket upgrades yet (no `Upgrade` / `Connection` headers), so until it does,
devices can only connect to a dev server's port 3001 directly.
