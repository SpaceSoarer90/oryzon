#!/usr/bin/env bash
set -euo pipefail

# Run from anywhere; Docker always uses the repository root as build context.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${ORYZON_IMAGE:-oryzon-sim:local}"
HOST_PORT="${HOST_PORT:-8000}"
ENV_FILE="${ORYZON_ENV_FILE:-$ROOT/sim-service/.env}"

command -v docker >/dev/null 2>&1 || {
  echo "Docker is required. Install/start Docker, then rerun this script." >&2
  exit 1
}

echo "Building ${IMAGE}; this also compiles DSSAT from source..."
docker build -t "$IMAGE" "$ROOT"

run_args=(--rm --name oryzon-sim -p "${HOST_PORT}:8000")
if [[ -f "$ENV_FILE" ]]; then
  echo "Loading service environment from $ENV_FILE"
  run_args+=(--env-file "$ENV_FILE")
else
  echo "No $ENV_FILE found; using image defaults."
  echo "Add required soil/Hugging Face settings to this file if your deployment needs them."
fi

echo "Starting DSSAT validation, then FastAPI/Uvicorn..."
echo "API: http://localhost:${HOST_PORT}"
echo "Health: http://localhost:${HOST_PORT}/health"
exec docker run "${run_args[@]}" "$IMAGE"
