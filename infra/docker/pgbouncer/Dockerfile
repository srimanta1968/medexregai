# PgBouncer in front of the app database (F8.1). Transaction pooling: many API and worker
# connections share a small number of server connections. Safe for this app because every
# per-request setting is transaction-local (set_config(..., true) in DataService) and no code holds
# session state between transactions. Migrations hold a session advisory lock, so they connect to
# Postgres directly and never through this pooler.
#
# Config comes from environment variables at start (entrypoint.sh); nothing secret is baked in.
FROM alpine:3.20

# Amazon RDS certificate bundle, so PgBouncer verifies the database server (verify-full).
# Release builds keep the default; a local test build may pass --build-arg RDS_CA_URL= (empty),
# and the container then refuses to start with TLS on (entrypoint.sh).
ARG RDS_CA_URL=https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

RUN apk add --no-cache pgbouncer \
  && addgroup -S pgbouncer && adduser -S -D -H -G pgbouncer pgbouncer \
  && mkdir -p /run/pgbouncer \
  && if [ -n "$RDS_CA_URL" ]; then wget -qO /etc/pgbouncer/rds-ca.pem "$RDS_CA_URL" && chmod 0644 /etc/pgbouncer/rds-ca.pem; fi \
  && chown -R pgbouncer:pgbouncer /etc/pgbouncer /run/pgbouncer

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh

USER pgbouncer
EXPOSE 6432
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
