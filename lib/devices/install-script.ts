// The device install script, served at GET /agent/devices/install.sh with this
// server's public address (APP_ORIGIN) filled in. Settings → Devices shows it
// with the pairing code:
//
//   curl -fsSL https://agent.example.com/agent/devices/install.sh | sh -s -- ABCDE-FGHJK
//
// It installs agent-device (the device client released with the agent CLI,
// eliachiarucci/agent-cli) and ffmpeg, lets the user pick the camera,
// microphone and speaker, pairs last (so a failed install doesn't use up the
// code), and starts it: a systemd service on Linux, in the terminal on macOS.
// --pair-only just pairs, writing ~/.config/agent-device/device.json for other
// device software to read. POSIX sh: it runs under dash on Debian.

const TEMPLATE = String.raw`#!/bin/sh
# Sets this computer up as a device of the agent at __SERVER__: an agent sees, hears and
# speaks through its devices (a camera, a microphone, a speaker).
#   curl -fsSL __SERVER__/agent/devices/install.sh | sh -s -- CODE
# CODE is the pairing code from the agent's Settings → Devices. It installs agent-device (and ffmpeg),
# asks which camera, microphone and speaker to use, pairs, and starts it (a service on Linux).
# Options: --pair-only   only pair: writes ~/.config/agent-device/device.json for your own device software
#          --server URL  another address of this server
set -eu

SERVER='__SERVER__'
REPO="${"${"}AGENT_DEVICE_REPO:-eliachiarucci/agent-cli}"
CODE=""
PAIR_ONLY=0
while [ $# -gt 0 ]; do
  case $1 in
    --pair-only) PAIR_ONLY=1 ;;
    --server) SERVER=${"${"}2:?--server needs an address}; shift ;;
    -*) echo "Unknown option $1" >&2; exit 2 ;;
    *) CODE=$1 ;;
  esac
  shift
done
SERVER=${"${"}SERVER%/}

if [ -z "$CODE" ]; then
  echo "Usage: curl -fsSL $SERVER/agent/devices/install.sh | sh -s -- CODE [--pair-only]" >&2
  echo "The code is on the agent's Settings → Devices (Add device, or Pair again)." >&2
  exit 2
fi
case $CODE in *[!A-Za-z0-9-]*) echo "That isn't a pairing code: $CODE" >&2; exit 2 ;; esac
case $SERVER in
  *[!A-Za-z0-9.:/_-]*) echo "That isn't a server address: $SERVER" >&2; exit 2 ;;
  http://*|https://*) ;;
  *) echo "The server address starts with https:// (or http://): $SERVER" >&2; exit 2 ;;
esac
if [ "$(id -u)" = 0 ]; then
  echo "Run it without sudo, as the user the device should run as; it asks for sudo when it needs it." >&2
  exit 1
fi

# Under "curl | sh" stdin is this script: prompts read the terminal instead.
with_tty() {
  if [ -t 0 ]; then "$@"; elif (: < /dev/tty) 2>/dev/null; then "$@" < /dev/tty; else "$@"; fi
}
as_root() {
  if command -v sudo >/dev/null 2>&1; then with_tty sudo "$@"; else echo "This step needs root: $*" >&2; exit 1; fi
}
has() { command -v "$1" >/dev/null 2>&1; }

OS=$(uname -s)
if [ $PAIR_ONLY = 0 ]; then
  case "$OS-$(uname -m)" in
    Darwin-arm64) target=macos-arm64 ;;
    Linux-x86_64) target=linux-x64 ;;
    Linux-aarch64 | Linux-arm64) target=linux-arm64 ;;
    *) echo "agent-device runs on Apple Silicon Macs and 64-bit Linux, not on $OS $(uname -m)." >&2
       echo "With your own device software, add --pair-only." >&2
       exit 1 ;;
  esac

  # ffmpeg captures the camera and microphone; aplay plays speech on Linux.
  if [ "$OS" = Darwin ]; then
    if ! has ffmpeg; then
      has brew || { echo "agent-device needs ffmpeg: install Homebrew (https://brew.sh), then run this again." >&2; exit 1; }
      echo "Installing ffmpeg..."
      brew install ffmpeg
    fi
  elif ! has ffmpeg || ! has aplay; then
    has apt-get || { echo "agent-device needs ffmpeg and aplay (alsa-utils): install them, then run this again." >&2; exit 1; }
    echo "Installing ffmpeg and alsa-utils (needs sudo)..."
    as_root apt-get update -qq
    as_root apt-get install -y -qq ffmpeg alsa-utils
  fi

  if [ -n "${"${"}AGENT_DEVICE_FILE:-}" ]; then
    tmp=$AGENT_DEVICE_FILE  # a local build, for development
  else
    tag=${"${"}AGENT_DEVICE_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)}
    [ -n "$tag" ] || { echo "Couldn't find the latest release of $REPO." >&2; exit 1; }
    base="https://github.com/$REPO/releases/download/$tag"
    echo "Downloading agent-device $tag ($target)..."
    tmp=$(mktemp)
    curl -f#SL "$base/agent-device-$target" -o "$tmp"
    expected=$(curl -fsSL "$base/agent-device-$target.sha256" | awk '{print $1}')
    if has shasum; then actual=$(shasum -a 256 "$tmp" | awk '{print $1}'); else actual=$(sha256sum "$tmp" | awk '{print $1}'); fi
    [ "$actual" = "$expected" ] || { echo "Checksum verification failed." >&2; rm -f "$tmp"; exit 1; }
  fi
  echo "Installing agent-device to /usr/local/bin (needs sudo)..."
  as_root mkdir -p /usr/local/bin
  as_root install -m 755 "$tmp" /usr/local/bin/agent-device
  [ -n "${"${"}AGENT_DEVICE_FILE:-}" ] || rm -f "$tmp"

  echo
  with_tty /usr/local/bin/agent-device setup
fi

# Pairing: the code, once, for this device's own key.
echo "Pairing with $SERVER..."
if ! RES=$(curl -fsS -X POST -H 'content-type: application/json' -d "{\"code\":\"$CODE\"}" "$SERVER/agent/devices/pair"); then
  echo "Pairing failed: the code is wrong, used or expired (it works once, for 30 minutes)." >&2
  echo "Get a new one on Settings → Devices → Pair again, and run the command again." >&2
  exit 1
fi
field() { printf '%s' "$RES" | sed -n "s/.*\"$1\":\"\([$2]*\)\".*/\1/p"; }
TOKEN=$(field token 'A-Za-z0-9_-')
DEVICE_ID=$(field id '0-9a-f-')
WS_PATH=$(field ws 'A-Za-z0-9/_-')
[ -n "$TOKEN" ] && [ -n "$WS_PATH" ] || { echo "Unexpected answer from the server: $RES" >&2; exit 1; }
URL="$(printf '%s' "$SERVER" | sed 's#^http#ws#')$WS_PATH"
DIR="$HOME/.config/agent-device"
(
  umask 077
  mkdir -p "$DIR"
  printf '{\n  "server": "%s",\n  "url": "%s",\n  "token": "%s",\n  "deviceId": "%s"\n}\n' \
    "$SERVER" "$URL" "$TOKEN" "$DEVICE_ID" > "$DIR/device.json"
)
echo "Paired. The device's key is in $DIR/device.json."

if [ $PAIR_ONLY = 1 ]; then
  echo "Your device software connects to $URL with that key (Authorization: Bearer)."
elif [ "$OS" = Linux ] && has systemctl && [ -d /run/systemd/system ]; then
  as_root /usr/local/bin/agent-device service install
  echo "Done: the device shows as Online on Settings → Devices."
else
  echo "Starting agent-device in this terminal: keep it open (Ctrl-C stops it; run agent-device to start it again)."
  echo
  with_tty exec /usr/local/bin/agent-device run
fi
`;

/** The script for a server at `origin` (an http(s) origin, nothing else). */
export function deviceInstallScript(origin: string): string {
  const server = new URL(origin).origin;
  return TEMPLATE.replaceAll("__SERVER__", server);
}
