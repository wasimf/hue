#!/usr/bin/env bash
#
# Starts the PaddleOCR sidecar in a local virtualenv.
# Run this in its own terminal, then start the app with:  ./start.sh --with-ocr
#
# The first run installs PaddlePaddle (~500 MB) and the first OCR request
# downloads the recognition models into ~/.paddleocr. Both are one-offs.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8868}"
VENV="${VENV:-.venv}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mx  \033[0m %s\n' "$1" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || fail "python3 is not installed. On macOS: brew install python"
info "Python $(python3 -V 2>&1 | cut -d' ' -f2)"

if [[ ! -d "$VENV" ]]; then
  info "Creating virtualenv in $VENV"
  python3 -m venv "$VENV"
fi

# shellcheck disable=SC1091
source "$VENV/bin/activate"

if ! python -c "import paddleocr" >/dev/null 2>&1; then
  info "Installing dependencies (first run only, this takes a few minutes)…"
  python -m pip install --quiet --upgrade pip
  if ! python -m pip install -r requirements.txt; then
    fail "Install failed. On Apple Silicon a wheel may be unavailable for your Python version;
    try Python 3.11 (brew install python@3.11 && VENV=.venv311 PYTHON=python3.11 ./start.sh),
    or run the sidecar in Docker with: docker compose up ocr"
  fi
fi

info "Starting PaddleOCR on http://127.0.0.1:${PORT}  (Ctrl-C to stop)"
exec uvicorn app:app --host 0.0.0.0 --port "$PORT"
