#!/bin/sh
# Writes pgbouncer.ini and the user list from the environment, then runs PgBouncer in the
# foreground. Required: DB_HOST, DB_NAME, APP_DB_USER, APP_DB_PASSWORD.
set -eu

: "${DB_HOST:?DB_HOST is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"
DB_PORT="${DB_PORT:-5432}"
LISTEN_PORT="${LISTEN_PORT:-6432}"
# Server-side TLS: verify-full against the RDS bundle in AWS; "disable" only for local dev.
SERVER_TLS_SSLMODE="${SERVER_TLS_SSLMODE:-verify-full}"
DEFAULT_POOL_SIZE="${DEFAULT_POOL_SIZE:-20}"
MAX_CLIENT_CONN="${MAX_CLIENT_CONN:-1000}"
MAX_DB_CONNECTIONS="${MAX_DB_CONNECTIONS:-40}"

case "$APP_DB_USER" in
  *[!a-zA-Z0-9_]*) echo "APP_DB_USER must be letters, digits or _" >&2; exit 1 ;;
esac

umask 077
# userlist.txt: "user" "password", with any double quote in the password doubled.
escaped=$(printf '%s' "$APP_DB_PASSWORD" | sed 's/"/""/g')
printf '"%s" "%s"\n' "$APP_DB_USER" "$escaped" > /etc/pgbouncer/userlist.txt

tls_ca=""
if [ "$SERVER_TLS_SSLMODE" != "disable" ]; then
  if [ ! -s /etc/pgbouncer/rds-ca.pem ]; then
    echo "SERVER_TLS_SSLMODE=$SERVER_TLS_SSLMODE but this image has no RDS CA bundle (built with an empty RDS_CA_URL)" >&2
    exit 1
  fi
  tls_ca="server_tls_ca_file = /etc/pgbouncer/rds-ca.pem"
fi

cat > /etc/pgbouncer/pgbouncer.ini <<EOF
[databases]
${DB_NAME} = host=${DB_HOST} port=${DB_PORT} dbname=${DB_NAME}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = ${LISTEN_PORT}
unix_socket_dir =
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = ${DEFAULT_POOL_SIZE}
max_client_conn = ${MAX_CLIENT_CONN}
max_db_connections = ${MAX_DB_CONNECTIONS}
server_reset_query =
server_tls_sslmode = ${SERVER_TLS_SSLMODE}
${tls_ca}
ignore_startup_parameters = extra_float_digits,options
server_idle_timeout = 300
query_wait_timeout = 30
log_connections = 0
log_disconnections = 0
stats_period = 60
EOF

exec pgbouncer /etc/pgbouncer/pgbouncer.ini
