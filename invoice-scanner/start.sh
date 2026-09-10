#!/usr/bin/env bash
#
# One-command start for local testing.
#
#   ./start.sh              parse PDFs that contain a text layer (no OCR needed)
#   ./start.sh --with-ocr   also use the PaddleOCR sidecar for scans and images
#
# Everything is optional and re-runnable: dependencies are only installed when
# they are missing.
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-3000}"
OCR_SERVICE_URL="${OCR_SERVICE_URL:-http://127.0.0.1:8868}"
WITH_OCR=false
[[ "${1:-}" == "--with-ocr" ]] && WITH_OCR=true

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!  \033[0m %s\n' "$1"; }
fail() { printf '\033[1;31mx  \033[0m %s\n' "$1" >&2; exit 1; }

# --- Node -------------------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is not installed. On macOS: brew install node"

node_major=$(node -p 'process.versions.node.split(".")[0]')
node_minor=$(node -p 'process.versions.node.split(".")[1]')
if (( node_major < 20 )) || { (( node_major == 20 )) && (( node_minor < 11 )); }; then
  fail "Node $(node -v) is too old; this needs v20.11 or newer. On macOS: brew upgrade node"
fi
info "Node $(node -v)"

# --- Dependencies -----------------------------------------------------------
if [[ ! -d node_modules ]]; then
  info "Installing dependencies (first run only)…"
  npm install --no-audit --no-fund
else
  info "Dependencies already installed"
fi

# --- Pick the OCR mode ------------------------------------------------------
if [[ "$WITH_OCR" == true ]]; then
  if curl -fsS --max-time 3 "${OCR_SERVICE_URL}/health" >/dev/null 2>&1; then
    info "PaddleOCR sidecar is up at ${OCR_SERVICE_URL}"
    export OCR_PROVIDER=paddle
    export OCR_SERVICE_URL
  else
    warn "No OCR sidecar at ${OCR_SERVICE_URL}."
    warn "Start it in another terminal with:  ./ocr-service/start.sh"
    warn "Continuing without OCR — text-layer PDFs still parse."
    export OCR_PROVIDER=none
  fi
else
  export OCR_PROVIDER=none
  info "Running without OCR. PDFs containing a text layer parse exactly;"
  info "scans and images need  ./start.sh --with-ocr"
fi

# --- Open the browser once the server answers -------------------------------
if [[ "$(uname)" == "Darwin" ]] && command -v open >/dev/null 2>&1; then
  (
    for _ in $(seq 1 40); do
      if curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        open "http://localhost:${PORT}"
        exit 0
      fi
      sleep 0.5
    done
  ) &
fi

info "Starting on http://localhost:${PORT}  (Ctrl-C to stop)"
PORT="$PORT" exec npm run dev
