#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to run MeshConfig Workbench." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8420}"

cd "${ROOT_DIR}"
echo "Serving MeshConfig Workbench from ${ROOT_DIR} at http://${HOST}:${PORT}"
exec python3 -m http.server "${PORT}" --bind "${HOST}"
