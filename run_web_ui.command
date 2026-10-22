#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
STAMP_FILE="$VENV_DIR/.requirements_installed"
DEFAULT_HOST="${MWT_HOST:-127.0.0.1}"
DEFAULT_PORT="${MWT_PORT:-8765}"
MAX_PORT_OFFSET="${MWT_PORT_SCAN_LIMIT:-20}"

pause_on_error() {
  echo
  read -r -p "문제가 발생했습니다. Enter를 누르면 종료합니다. " _
}

open_url() {
  local url="$1"
  if [ "${MWT_SKIP_OPEN:-0}" = "1" ]; then
    return 0
  fi

  if command -v open >/dev/null 2>&1; then
    open "$url" >/dev/null 2>&1 || true
  fi
}

is_ui_alive() {
  local host="$1"
  local port="$2"
  curl -fsS --max-time 1 "http://${host}:${port}/healthz" >/dev/null 2>&1
}

port_in_use() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])
families = [socket.AF_INET]
if ":" in host:
    families = [socket.AF_INET6]

for family in families:
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.bind((host, port))
    except OSError:
        print("used")
        raise SystemExit(0)
    finally:
        sock.close()

print("free")
PY
}

pick_port() {
  local host="$1"
  local start_port="$2"
  local max_offset="$3"
  local current_port
  local state

  for ((offset=0; offset<=max_offset; offset++)); do
    current_port=$((start_port + offset))
    if is_ui_alive "$host" "$current_port"; then
      echo "running:$current_port"
      return 0
    fi
    state="$(port_in_use "$host" "$current_port")"
    if [ "$state" = "free" ]; then
      echo "free:$current_port"
      return 0
    fi
  done

  echo "none:"
}

trap 'pause_on_error' ERR

echo "[Minecraft World Translator] 준비 중..."

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3를 찾을 수 없습니다. Python 3.11+를 먼저 설치하세요."
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "[1/4] 가상환경 생성"
  python3 -m venv "$VENV_DIR"
fi

# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

if [ ! -f "$STAMP_FILE" ] || [ "$SCRIPT_DIR/requirements.txt" -nt "$STAMP_FILE" ]; then
  echo "[2/4] 의존성 설치"
  python3 -m pip install --upgrade pip
  python3 -m pip install -r "$SCRIPT_DIR/requirements.txt"
  touch "$STAMP_FILE"
else
  echo "[2/4] 의존성 확인 완료"
fi

echo "[3/4] 웹 UI 실행 준비"
ARGS=()
PORT_RESULT="$(pick_port "$DEFAULT_HOST" "$DEFAULT_PORT" "$MAX_PORT_OFFSET")"
PORT_STATE="${PORT_RESULT%%:*}"
PORT_VALUE="${PORT_RESULT#*:}"

if [ "$PORT_STATE" = "running" ]; then
  URL="http://${DEFAULT_HOST}:${PORT_VALUE}"
  echo "이미 실행 중인 웹 UI를 찾았습니다: $URL"
  open_url "$URL"
  exit 0
fi

if [ "$PORT_STATE" != "free" ] || [ -z "$PORT_VALUE" ]; then
  echo "사용 가능한 포트를 찾지 못했습니다. MWT_PORT 또는 MWT_PORT_SCAN_LIMIT 값을 조정하세요."
  exit 1
fi

ARGS+=(--host "$DEFAULT_HOST" --port "$PORT_VALUE")
if [ "${MWT_ALLOW_REMOTE:-0}" = "1" ]; then
  ARGS+=(--allow-remote)
fi
if [ "${MWT_SKIP_OPEN:-0}" != "1" ]; then
  ARGS+=(--open-browser)
fi

if [ "$PORT_VALUE" != "$DEFAULT_PORT" ]; then
  echo "기본 포트 $DEFAULT_PORT 는 사용 중이라 $PORT_VALUE 포트로 실행합니다."
fi

echo "[4/4] 웹 UI 시작"
cd "$SCRIPT_DIR"
exec python3 "$SCRIPT_DIR/webui_server.py" "${ARGS[@]}"
