#!/usr/bin/env bash
# =============================================================================
# MedexRegAI - pull the local AI models into Ollama
#
# Reads AI_PROVIDER, AI_BASE_URL, AI_GENERATION_MODEL and AI_EMBEDDING_MODEL from
# server/.env (environment variables override), asks Ollama to pull each model that
# is not already present, and verifies all of them are listed afterwards.
#
# The default stack is our own self-hosted models; nothing here contacts a
# third-party AI provider. When AI_PROVIDER is not "ollama" (vLLM or a hosted
# provider), models are managed there and this script exits 0 without pulling.
#
# Usage:  scripts/pull-models.sh [--extra <model>]...   (e.g. --extra bge-reranker-v2-m3)
# Exit:   0 all models present (or provider is not Ollama)
#         1 Ollama unreachable or a pull failed      2 bad usage
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_ENV="$ROOT/server/.env"

# env_value <key> <fallback> -> value as dotenv reads it (same rules as setup-env.sh)
env_value() {
  local key="$1" fallback="$2" line=""
  if [ -f "$SERVER_ENV" ]; then
    line="$(grep -E "^${key}=" "$SERVER_ENV" | tail -1 || true)"
    if [ -n "$line" ]; then
      line="${line#*=}"
      line="${line#"${line%%[![:space:]]*}"}"
      case "$line" in
        \#*) line="" ;;   # blank value followed by an inline comment
        \'*) line="${line#\'}"; line="${line%%\'*}" ;;
        \"*) line="${line#\"}"; line="${line%%\"*}" ;;
        *)   line="$(printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" ;;
      esac
    fi
  fi
  printf '%s' "${line:-$fallback}"
}

PROVIDER="${AI_PROVIDER:-$(env_value AI_PROVIDER ollama)}"
BASE_URL="${AI_BASE_URL:-$(env_value AI_BASE_URL http://localhost:11434)}"
BASE_URL="${BASE_URL%/}"
MODELS=(
  "${AI_GENERATION_MODEL:-$(env_value AI_GENERATION_MODEL qwen2.5:7b-instruct)}"
  "${AI_EMBEDDING_MODEL:-$(env_value AI_EMBEDDING_MODEL bge-m3)}"
)

while [ $# -gt 0 ]; do
  case "$1" in
    --extra)
      [ $# -ge 2 ] || { echo "--extra needs a model name" >&2; exit 2; }
      MODELS+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$PROVIDER" != "ollama" ]; then
  echo "AI_PROVIDER is '$PROVIDER': models are managed by that provider, nothing to pull."
  exit 0
fi

# Ollama model names: registry/namespace/name:tag. Anything else is refused, which
# also keeps the JSON request body below free of injected quotes.
for model in "${MODELS[@]}"; do
  if ! [[ "$model" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?$ ]]; then
    echo "Invalid model name: '$model'" >&2
    exit 2
  fi
done

echo "MedexRegAI model setup (Ollama at $BASE_URL)"

if ! curl -fsS -m 5 "$BASE_URL/api/tags" >/dev/null 2>&1; then
  echo "  Ollama is not reachable at $BASE_URL." >&2
  echo "  Start Ollama first ('ollama serve', or the ollama service in docker compose)." >&2
  exit 1
fi

# Model names exactly as Ollama lists them, parsed as JSON (whitespace-safe).
installed() {
  curl -fsS -m 10 "$BASE_URL/api/tags" | node -e '
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      const tags = JSON.parse(s || "{}");
      for (const m of tags.models || []) console.log(m.name || m.model || "");
    });'
}

is_installed() {
  local want="$1" have
  [[ "$want" == *:* ]] || want="${want}:latest"   # "bge-m3" is listed as "bge-m3:latest"
  while IFS= read -r have; do
    [ "$have" = "$want" ] && return 0
  done < <(installed)
  return 1
}

failed=0
for model in "${MODELS[@]}"; do
  if is_installed "$model"; then
    echo "  ✓ $model already present"
    continue
  fi
  echo "  ↓ pulling $model (first pull can take several minutes)..."
  # stream:false -> one response when the pull finished or failed. "model" is the
  # current field name; "name" is kept for older Ollama releases.
  response="$(curl -sS -m 3600 -X POST "$BASE_URL/api/pull" \
    -H 'Content-Type: application/json' \
    -d "{\"model\": \"$model\", \"name\": \"$model\", \"stream\": false}" || true)"
  if printf '%s' "$response" | grep -qE '"status"[[:space:]]*:[[:space:]]*"success"'; then
    echo "  ✓ $model pulled"
  else
    echo "  ✗ $model failed: ${response:-no response}" >&2
    failed=$((failed + 1))
  fi
done

for model in "${MODELS[@]}"; do
  if ! is_installed "$model"; then
    echo "  ✗ $model is not listed by Ollama after pulling" >&2
    failed=$((failed + 1))
  fi
done

if [ "$failed" -gt 0 ]; then
  echo "  $failed model problem(s)." >&2
  exit 1
fi
echo "  All ${#MODELS[@]} model(s) present."
