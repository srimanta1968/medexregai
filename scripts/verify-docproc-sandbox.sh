#!/usr/bin/env bash
# =============================================================================
# Verify the local docproc sandbox (F7.2, ADR-013) is really a sandbox.
#
# Checks the RUNNING container, not the compose file:
#   1. it is attached only to an internal network (no route out)
#   2. it cannot reach the internet, by IP or by name, from inside
#   3. read-only root, no Linux capabilities, no-new-privileges, non-root user
#   4. CPU, memory and process limits are set
#   5. the host still reaches it through docproc-gateway, and /v1 needs the key
#
# Usage:  docker compose up -d docproc docproc-gateway
#         scripts/verify-docproc-sandbox.sh
# Exit:   0 every check passed, 1 a check failed, 2 docproc is not running
# =============================================================================
set -uo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-medexregai}"
PORT="${DOCPROC_HOST_PORT:-4200}"
failures=0

pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; failures=$((failures + 1)); }

cid="$(docker ps -q --filter "label=com.docker.compose.project=${PROJECT}" --filter "label=com.docker.compose.service=docproc")"
if [ -z "$cid" ]; then
  echo "docproc is not running. Start it with: docker compose up -d docproc docproc-gateway" >&2
  exit 2
fi
echo "docproc sandbox checks (container ${cid:0:12})"

inspect() { docker inspect -f "$1" "$cid"; }

# 1. Networks: every attached network must be internal.
networks="$(inspect '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
for net in $networks; do
  if [ "$(docker network inspect -f '{{.Internal}}' "$net")" = "true" ]; then
    pass "network $net is internal (no gateway out)"
  else
    fail "network $net is NOT internal: docproc could reach the outside"
  fi
done
[ -n "$networks" ] || fail "docproc is attached to no network"
[ "$(inspect '{{len .HostConfig.PortBindings}}')" = "0" ] && pass "no ports published to the host" || fail "docproc publishes ports; only docproc-gateway should"

# 2. Egress, tried from inside with the container's own Python.
probe() {
  docker exec "$cid" python -c "$1" >/dev/null 2>&1
}
if probe "import socket; socket.create_connection(('1.1.1.1', 443), 4)"; then
  fail "reached 1.1.1.1:443 from inside docproc"
else
  pass "cannot connect out by IP (1.1.1.1:443)"
fi
if probe "import socket; socket.getaddrinfo('example.com', 443)"; then
  fail "resolved example.com from inside docproc"
else
  pass "cannot resolve public names (example.com)"
fi

# 3. Hardening.
[ "$(inspect '{{.HostConfig.ReadonlyRootfs}}')" = "true" ] && pass "read-only root filesystem" || fail "root filesystem is writable"
caps="$(inspect '{{json .HostConfig.CapDrop}}')"
case "$caps" in *ALL*) pass "all Linux capabilities dropped" ;; *) fail "capabilities not dropped (CapDrop=$caps)" ;; esac
secopt="$(inspect '{{json .HostConfig.SecurityOpt}}')"
case "$secopt" in *no-new-privileges*) pass "no-new-privileges" ;; *) fail "no-new-privileges missing ($secopt)" ;; esac
uid="$(docker exec "$cid" id -u 2>/dev/null)"
[ -n "$uid" ] && [ "$uid" != "0" ] && pass "runs as uid $uid (not root)" || fail "runs as root"

# 4. Resource limits.
cpus="$(inspect '{{.HostConfig.NanoCpus}}')"
mem="$(inspect '{{.HostConfig.Memory}}')"
pids="$(inspect '{{.HostConfig.PidsLimit}}')"
[ "${cpus:-0}" -gt 0 ] && pass "CPU limit $((cpus / 1000000000)) CPU(s)" || fail "no CPU limit"
[ "${mem:-0}" -gt 0 ] && pass "memory limit $((mem / 1024 / 1024)) MiB" || fail "no memory limit"
[ -n "$pids" ] && [ "$pids" != "<nil>" ] && [ "$pids" -gt 0 ] 2>/dev/null && pass "process limit $pids" || fail "no process limit"

# 5. Reachable from the host through the gateway, and the parse API needs the key.
if curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null; then
  pass "host reaches docproc at 127.0.0.1:${PORT} through docproc-gateway"
else
  fail "host cannot reach docproc at 127.0.0.1:${PORT} (is docproc-gateway up?)"
fi
code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -H 'X-File-Name: probe.txt' --data-binary 'x' "http://127.0.0.1:${PORT}/v1/parse")"
[ "$code" = "401" ] && pass "/v1/parse without X-Docproc-Key answers 401" || fail "/v1/parse without a key answered $code (expected 401)"

echo
if [ "$failures" -eq 0 ]; then
  echo "docproc sandbox: all checks passed"
  exit 0
fi
echo "docproc sandbox: $failures check(s) failed"
exit 1
