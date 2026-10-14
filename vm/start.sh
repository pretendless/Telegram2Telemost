#!/usr/bin/env bash
# Chromium (virtual screen) + noVNC + the Telemost login/upload scripts.
# Secrets come from the environment. This script does not print them on GitHub Actions.
set -euo pipefail

cd /opt/tg2tm

export MODE="${MODE:-login}"
export ACCOUNT="${ACCOUNT:-default}"
export PACKS="${PACKS:-}"
export CHAT_ID="${TELEGRAM_CHAT_ID:-${CHAT_ID:-}}"
export TELEGRAM_CHAT_ID="$CHAT_ID"
export SESSION_DIR="${SESSION_DIR:-/tmp/tg2tm-sessions}"
export PROFILE_DIR="${PROFILE_DIR:-/tmp/tg2tm-profiles}"
export DISPLAY="${DISPLAY:-:99}"
export DEVTOOLS="${DEVTOOLS:-http://127.0.0.1:9222}"
export CLOUDFLARED_VERSION="${CLOUDFLARED_VERSION:-2026.10.0}"

node vm/inputs.mjs --check

mkdir -p "$SESSION_DIR" "$PROFILE_DIR" /tmp
if [ ! -w "$SESSION_DIR" ]; then
  echo "SESSION_DIR is not writable"
  exit 1
fi

if [ -z "${NOVNC_PASSWORD:-}" ]; then
  NOVNC_PASSWORD="$(node -e "process.stdout.write(require('crypto').randomBytes(12).toString('base64url'))")"
  export NOVNC_PASSWORD
fi
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
  echo "::add-mask::${NOVNC_PASSWORD}"
fi

CHROME="${CHROME_BIN:-}"
if [ -z "$CHROME" ]; then
  for candidate in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
    if [ -x "$candidate" ]; then
      CHROME="$candidate"
      break
    fi
  done
fi
if [ -z "$CHROME" ]; then
  echo "chromium is not installed"
  exit 1
fi

pids=()
cleanup() {
  local pid
  if [ "${#pids[@]}" -eq 0 ]; then
    return
  fi
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac +extension GLX +render -noreset >/tmp/tg2tm-xvfb.log 2>&1 &
pids+=("$!")

PROFILE="$PROFILE_DIR/$ACCOUNT"
rm -rf "$PROFILE"
mkdir -p "$PROFILE"

chrome_args=(
  --no-sandbox
  --disable-setuid-sandbox
  --disable-dev-shm-usage
  --disable-gpu
  --window-size=1280,800
  --window-position=0,0
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port=9222
  --user-data-dir="$PROFILE"
  --lang=ru-RU
  --accept-lang=ru-RU,ru
  --no-first-run
  --no-default-browser-check
  --disable-blink-features=AutomationControlled
  --remote-allow-origins=*
)
proxy_flag="$(node vm/proxy.mjs)"
if [ -n "$proxy_flag" ]; then
  echo "::add-mask::${PROXY_HOST}"
  echo "proxy on"
  chrome_args+=("$proxy_flag")
else
  echo "proxy off"
fi
"$CHROME" "${chrome_args[@]}" about:blank >/tmp/tg2tm-chrome.log 2>&1 &
pids+=("$!")

ready=0
for _ in $(seq 1 50); do
  if curl -sf "$DEVTOOLS/json/version" >/dev/null; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "chromium did not open the debugging port"
  exit 1
fi

umask 077
printf '%s\n' "$NOVNC_PASSWORD" >/tmp/tg2tm-vnc.pass
x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 -localhost \
  -passwdfile /tmp/tg2tm-vnc.pass -noxdamage >/tmp/tg2tm-vnc.log 2>&1 &
pids+=("$!")

websockify --web /usr/share/novnc 6080 127.0.0.1:5900 >/tmp/tg2tm-novnc.log 2>&1 &
pids+=("$!")

start_tunnel() {
  local arch dest expected url
  case "$(uname -m)" in
    x86_64) arch=amd64; expected=d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db ;;
    aarch64 | arm64) arch=arm64; expected=e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08 ;;
    *)
      echo "tunnel skipped: unsupported arch"
      return
      ;;
  esac
  dest="/tmp/cloudflared"
  if ! curl -fsSL --max-time 60 \
    -o "$dest" \
    "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}"; then
    echo "tunnel skipped: download failed"
    return
  fi
  if ! echo "${expected}  ${dest}" | sha256sum -c - >/dev/null; then
    echo "tunnel skipped: checksum mismatch"
    rm -f "$dest"
    return
  fi
  chmod 755 "$dest"
  "$dest" tunnel --no-autoupdate --url http://127.0.0.1:6080 >/tmp/tg2tm-tunnel.log 2>&1 &
  pids+=("$!")
  local _
  for _ in $(seq 1 25); do
    if [ -s /tmp/tg2tm-tunnel.log ]; then
      url="$(node vm/tunnel_url.mjs </tmp/tg2tm-tunnel.log || true)"
      if [ -n "$url" ]; then
        printf '%s' "$url" >/tmp/tg2tm-tunnel.url
        return
      fi
    fi
    sleep 1
  done
  echo "tunnel skipped: no public url"
}

if [ "${ENABLE_TUNNEL:-}" = "1" ]; then
  start_tunnel || true
  if [ -s /tmp/tg2tm-tunnel.url ]; then
    PUBLIC_NOVNC_URL="$(cat /tmp/tg2tm-tunnel.url)"
    export PUBLIC_NOVNC_URL
    if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
      echo "::add-mask::${PUBLIC_NOVNC_URL}"
    else
      echo "noVNC ${PUBLIC_NOVNC_URL}/vnc.html"
    fi
  fi
fi

if [ "${GITHUB_ACTIONS:-}" != "true" ]; then
  echo "noVNC http://127.0.0.1:6080/vnc.html"
  echo "noVNC password: ${NOVNC_PASSWORD}"
fi

status=0
read -r -a pack_args <<<"$PACKS"
if [ "$MODE" = "login" ]; then
  node vm/login.mjs login || status=$?
elif [ "$MODE" = "finalize" ]; then
  node vm/login.mjs restore || status=$?
  if [ "$status" -eq 0 ]; then
    node scripts/telemost_upload.mjs --finalize "${pack_args[@]}" || status=$?
    node vm/login.mjs save || true
  fi
elif [ "$MODE" = "restart-peek" ]; then
  node vm/login.mjs restore || status=$?
  if [ "$status" -eq 0 ]; then
    node scripts/telemost_upload.mjs --restart-peek || status=$?
  fi
elif [ "$MODE" = "restart" ]; then
  node vm/login.mjs restore || status=$?
  if [ "$status" -eq 0 ]; then
    export TG2TM_QUEUE_DRAIN="${TG2TM_QUEUE_DRAIN:-1}"
    export TG2TM_DRAIN_IDLE_MS="${TG2TM_DRAIN_IDLE_MS:-90000}"
    node scripts/telemost_upload.mjs --restart --drain-queue || status=$?
    node vm/login.mjs save || true
  fi
else
  node vm/login.mjs restore || status=$?
  if [ "$status" -eq 0 ]; then
    export TG2TM_QUEUE_DRAIN="${TG2TM_QUEUE_DRAIN:-1}"
    if [ -n "$PACKS" ]; then
      export TG2TM_DRAIN_IDLE_MS="${TG2TM_DRAIN_IDLE_MS:-0}"
      # Always close the pack after upload. Title and stickers come from pack.json.
      node scripts/telemost_upload.mjs --close "${pack_args[@]}" || status=$?
    else
      export TG2TM_DRAIN_IDLE_MS="${TG2TM_DRAIN_IDLE_MS:-90000}"
    fi
    if [ "${TG2TM_QUEUE_DRAIN}" = "1" ]; then
      node scripts/telemost_upload.mjs --drain-queue-only || status=$?
    fi
    node vm/login.mjs save || true
  fi
fi
exit "$status"
