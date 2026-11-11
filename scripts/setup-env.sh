#!/usr/bin/env bash
# =============================================================================
# MedexRegAI - environment and secrets setup
#
# Creates (or tops up) the gitignored env files from their committed templates:
#   server/.env   <- server/.env.example
#   client/.env   <- client/.env.example
#   .env          <- credentials docker compose needs (kept in sync with server/.env)
#
# Rules:
#   * A key that already has a real value is NEVER changed.
#   * Keys missing from an existing file are appended from the template.
#   * Blank secrets, and secrets still holding a template placeholder
#     ("change_this", "your_...", "changeme"), are generated with a CSPRNG.
#   * DB_PASSWORD is never invented: pass --db-password, export DB_PASSWORD,
#     or answer the prompt. Without it the script exits 1 (the API would not start).
#   * Values are written quoted, so '#', spaces and '$' survive dotenv parsing.
#   * The result is checked with the same rules the API applies at startup.
#
# Usage:  scripts/setup-env.sh [--db-password <pw>] [--rotate-jwt-secret]
#   --rotate-jwt-secret  issue a new JWT_SECRET (signs everyone out). ENCRYPTION_KEY
#                        and the S3 storage secret are never rotated here: rotating them
#                        would make stored tokens unreadable and lock the API out of
#                        existing local object storage.
# Exit:   0 ready, 1 a required setting is missing or invalid, 2 bad usage
# =============================================================================
set -euo pipefail
umask 077   # env files hold secrets: create them readable by the owner only

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_ENV="$ROOT/server/.env"
SERVER_EXAMPLE="$ROOT/server/.env.example"
CLIENT_ENV="$ROOT/client/.env"
CLIENT_EXAMPLE="$ROOT/client/.env.example"
ROOT_ENV="$ROOT/.env"

GENERATED_SECRETS=(JWT_SECRET ENCRYPTION_KEY S3_SECRET_ACCESS_KEY DOCPROC_API_KEY)
DB_PASSWORD_ARG="${DB_PASSWORD:-}"
ROTATE_JWT=false

while [ $# -gt 0 ]; do
  case "$1" in
    --db-password)
      [ $# -ge 2 ] || { echo "--db-password needs a value" >&2; exit 2; }
      DB_PASSWORD_ARG="$2"; shift 2 ;;
    --rotate-jwt-secret) ROTATE_JWT=true; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

log()  { printf '  %s\n' "$*"; }
warn() { printf '  WARNING: %s\n' "$*" >&2; }

# --- secret generation -------------------------------------------------------
# hex_secret <bytes> -> 2*bytes hex chars from a CSPRNG (node, else openssl).
hex_secret() {
  local bytes="$1"
  if command -v node >/dev/null 2>&1; then
    node -e "process.stdout.write(require('crypto').randomBytes($bytes).toString('hex'))"
  elif command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    echo "Neither node nor openssl is available to generate secrets." >&2
    exit 1
  fi
}

secret_for() {
  case "$1" in
    JWT_SECRET) hex_secret 48 ;;           # 96 chars
    ENCRYPTION_KEY) hex_secret 32 ;;       # 64 hex chars = AES-256 key
    S3_SECRET_ACCESS_KEY) hex_secret 24 ;; # 48 chars
    *) hex_secret 32 ;;
  esac
}

# --- .env helpers ---------------------------------------------------------------
# get_value <file> <key> -> the value as dotenv reads it:
#   'single' or "double" quoted -> the text between the quotes;
#   unquoted -> up to an inline ' #' comment, trimmed.
get_value() {
  local file="$1" key="$2" line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -1 || true)"
  [ -z "$line" ] && return 0
  line="${line#*=}"
  line="${line#"${line%%[![:space:]]*}"}"          # trim leading space
  case "$line" in
    ''|\#*) return 0 ;;   # blank value, possibly followed by an inline comment
    \'*) line="${line#\'}"; printf '%s' "${line%%\'*}" ;;
    \"*) line="${line#\"}"; printf '%s' "${line%%\"*}" ;;
    *)   printf '%s' "$line" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' ;;
  esac
}

has_key() { grep -qE "^${2}=" "$1" 2>/dev/null; }

# quote_value <value> -> a dotenv-safe literal. Single quotes keep everything
# verbatim; a value that itself contains a single quote is double-quoted.
quote_value() {
  local v="$1"
  if [[ "$v" != *"'"* ]]; then
    printf "'%s'" "$v"
  elif [[ "$v" != *'"'* && "$v" != *'\'* ]]; then
    printf '"%s"' "$v"
  else
    echo "Value contains both quote types; set it in server/.env by hand." >&2
    exit 2
  fi
}

# set_value <file> <key> <value> -> replace the line in place, or append it
set_value() {
  local file="$1" key="$2" quoted tmp
  quoted="$(quote_value "$3")"
  tmp="$(mktemp)"
  if has_key "$file" "$key"; then
    # Value via ENVIRON, not -v: awk -v would interpret backslashes.
    SETUP_ENV_VALUE="$quoted" awk -v k="$key" \
      'index($0, k"=") == 1 {print k"="ENVIRON["SETUP_ENV_VALUE"]; next} {print}' "$file" > "$tmp"
  else
    cat "$file" > "$tmp"
    printf '%s=%s\n' "$key" "$quoted" >> "$tmp"
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

is_placeholder() {
  case "$1" in
    ""|*change_this*|*CHANGE_THIS*|your_*|your-*|YOUR_*|changeme|*placeholder*) return 0 ;;
    *) return 1 ;;
  esac
}

# merge_template <template> <target> -> create target or append keys it lacks
merge_template() {
  local template="$1" target="$2" added=0 key
  if [ ! -f "$target" ]; then
    cp "$template" "$target"
    chmod 600 "$target" 2>/dev/null || true
    log "created ${target#"$ROOT"/} from ${template#"$ROOT"/}"
    return 0
  fi
  while IFS= read -r key; do
    if ! has_key "$target" "$key"; then
      grep -E "^${key}=" "$template" | head -1 >> "$target"
      added=$((added + 1))
    fi
  done < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$template" | tr -d '=')
  log "${target#"$ROOT"/} exists; added $added missing key(s), existing values kept"
}

echo "MedexRegAI environment setup"

# --- server/.env -------------------------------------------------------------
merge_template "$SERVER_EXAMPLE" "$SERVER_ENV"
chmod 600 "$SERVER_ENV" 2>/dev/null || true

for key in "${GENERATED_SECRETS[@]}"; do
  if is_placeholder "$(get_value "$SERVER_ENV" "$key")"; then
    set_value "$SERVER_ENV" "$key" "$(secret_for "$key")"
    log "generated $key"
  fi
done
if $ROTATE_JWT; then
  set_value "$SERVER_ENV" JWT_SECRET "$(secret_for JWT_SECRET)"
  log "rotated JWT_SECRET (existing sessions are now invalid)"
fi

if [ -z "$(get_value "$SERVER_ENV" DB_PASSWORD)" ]; then
  if [ -z "$DB_PASSWORD_ARG" ] && [ -t 0 ]; then
    read -r -s -p "  Local Postgres password for $(get_value "$SERVER_ENV" DB_USER)@$(get_value "$SERVER_ENV" DB_HOST): " DB_PASSWORD_ARG
    echo
  fi
  if [ -n "$DB_PASSWORD_ARG" ]; then
    set_value "$SERVER_ENV" DB_PASSWORD "$DB_PASSWORD_ARG"
    log "set DB_PASSWORD"
  fi
fi

# --- root .env: credentials docker compose needs ---------------------------------
touch "$ROOT_ENV"
chmod 600 "$ROOT_ENV" 2>/dev/null || true
set_value "$ROOT_ENV" S3_ACCESS_KEY_ID "$(get_value "$SERVER_ENV" S3_ACCESS_KEY_ID)"
set_value "$ROOT_ENV" S3_SECRET_ACCESS_KEY "$(get_value "$SERVER_ENV" S3_SECRET_ACCESS_KEY)"
log ".env S3 storage credentials match server/.env"
# The sandboxed docproc container checks the same key the API and worker send.
set_value "$ROOT_ENV" DOCPROC_API_KEY "$(get_value "$SERVER_ENV" DOCPROC_API_KEY)"
log ".env docproc key matches server/.env"
# The compose Postgres (port 5433) uses the same password as server/.env.
if [ -n "$(get_value "$SERVER_ENV" DB_PASSWORD)" ]; then
  set_value "$ROOT_ENV" POSTGRES_PASSWORD "$(get_value "$SERVER_ENV" DB_PASSWORD)"
  set_value "$ROOT_ENV" POSTGRES_USER "$(get_value "$SERVER_ENV" DB_USER)"
  set_value "$ROOT_ENV" S3_BUCKET "$(get_value "$SERVER_ENV" S3_BUCKET)"
  log ".env Postgres credentials and bucket match server/.env"
fi

# --- client/.env (no secrets: only VITE_* values reach the browser) ------------
merge_template "$CLIENT_EXAMPLE" "$CLIENT_ENV"

# --- verify with the API's own startup rules -------------------------------------
problems=0
for key in $(grep -E '#.*REQUIRED' "$SERVER_EXAMPLE" | grep -oE '^[A-Z][A-Z0-9_]*'); do
  if [ -z "$(get_value "$SERVER_ENV" "$key")" ]; then
    warn "required $key is blank in server/.env"
    problems=$((problems + 1))
  fi
done
jwt="$(get_value "$SERVER_ENV" JWT_SECRET)"
if [ -n "$jwt" ] && [ "${#jwt}" -lt 32 ]; then
  warn "JWT_SECRET is shorter than 32 characters; the API will refuse it (use --rotate-jwt-secret)"
  problems=$((problems + 1))
fi
enc="$(get_value "$SERVER_ENV" ENCRYPTION_KEY)"
if [ -n "$enc" ] && ! [[ "$enc" =~ ^[0-9a-fA-F]{64}$ ]]; then
  warn "ENCRYPTION_KEY must be 64 hex characters; the API will refuse it"
  problems=$((problems + 1))
fi

if [ "$problems" -gt 0 ]; then
  echo "  $problems problem(s) in server/.env; the API will not start until they are fixed."
  exit 1
fi
echo "  All required server settings are present and valid."
echo "Next: scripts/pull-models.sh to download the local AI models."
