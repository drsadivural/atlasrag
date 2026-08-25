#!/usr/bin/env bash
#
# Provisions the staging database for UXE Consulting AI.
#
# Run this ON the database host (azure36). It is idempotent: running it twice leaves the
# same state and re-prints the connection string.
#
#   sudo bash provision-postgres.sh
#
# What it does:
#   - installs PostgreSQL 16 and the pgvector extension from the PGDG repository
#   - creates the `uxe` role and `uxe_staging` database, generating a password if none is
#     supplied, and enables `vector` and `pg_trgm` inside that database
#   - tunes the settings the retrieval path actually depends on (an HNSW index build needs
#     more maintenance_work_mem than the default allows)
#   - leaves PostgreSQL listening on localhost only, and prints the two ways to reach it
#     from Cloudflare
#
# It deliberately does NOT open the database to the internet. See the closing notes.

set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
DB_NAME="${DB_NAME:-uxe_staging}"
DB_USER="${DB_USER:-uxe}"
DB_PASSWORD="${DB_PASSWORD:-}"
LISTEN="${LISTEN:-127.0.0.1}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

# systemd is the normal case on a VM, but this also has to work on a host without it —
# a container image, WSL, a minimal cloud image — so the service control falls back to
# PostgreSQL's own tooling rather than aborting.
start_postgres() {
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    start_postgres
wait_for_postgres
    return
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster "${PG_VERSION}" main start >/dev/null 2>&1 || true
    return
  fi
  runuser -u postgres -- "/usr/lib/postgresql/${PG_VERSION}/bin/pg_ctl" \
    -D "${PG_DATA_DIR}" -l /tmp/pg.log start >/dev/null 2>&1 || true
}

restart_postgres() {
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl restart "${PG_SERVICE}"
    return
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster "${PG_VERSION}" main restart >/dev/null 2>&1 || \
      pg_ctlcluster "${PG_VERSION}" main start >/dev/null 2>&1
    return
  fi
  runuser -u postgres -- "/usr/lib/postgresql/${PG_VERSION}/bin/pg_ctl" \
    -D "${PG_DATA_DIR}" -l /tmp/pg.log restart >/dev/null 2>&1
}

wait_for_postgres() {
  for _ in $(seq 1 30); do
    runuser -u postgres -- psql -tAc 'SELECT 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  fail "PostgreSQL did not accept connections after 30s"
}

[[ ${EUID} -eq 0 ]] || fail "Run as root: sudo bash $0"

# --- 1. Packages ------------------------------------------------------------

if command -v apt-get >/dev/null 2>&1; then
  log "Installing PostgreSQL ${PG_VERSION} and pgvector (Debian/Ubuntu)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg lsb-release >/dev/null

  # PGDG carries both the server and the matching pgvector build; the distribution
  # repositories often carry neither at the version this schema expects.
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  apt-get install -y -qq "postgresql-${PG_VERSION}" "postgresql-${PG_VERSION}-pgvector" >/dev/null

  PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/main"
  PG_DATA_DIR="/var/lib/postgresql/${PG_VERSION}/main"
  PG_SERVICE="postgresql"
elif command -v dnf >/dev/null 2>&1; then
  log "Installing PostgreSQL ${PG_VERSION} and pgvector (RHEL family)"
  dnf install -y -q \
    "https://download.postgresql.org/pub/repos/yum/reporpms/EL-$(rpm -E %{rhel})-x86_64/pgdg-redhat-repo-latest.noarch.rpm" || true
  dnf -qy module disable postgresql || true
  dnf install -y -q "postgresql${PG_VERSION}-server" "pgvector_${PG_VERSION}"
  [[ -d "/var/lib/pgsql/${PG_VERSION}/data/base" ]] || "/usr/pgsql-${PG_VERSION}/bin/postgresql-${PG_VERSION}-setup" initdb
  PG_CONF_DIR="/var/lib/pgsql/${PG_VERSION}/data"
  PG_DATA_DIR="/var/lib/pgsql/${PG_VERSION}/data"
  PG_SERVICE="postgresql-${PG_VERSION}"
else
  fail "Unsupported distribution: need apt-get or dnf"
fi

systemctl enable --now "${PG_SERVICE}" >/dev/null 2>&1 || true

# --- 2. Settings ------------------------------------------------------------

log "Applying settings"

# A separate file rather than edits to postgresql.conf: a package upgrade will not fight
# with it, and what this application changed stays legible.
cat > "${PG_CONF_DIR}/conf.d-uxe.conf" <<CONF
# UXE Consulting AI — staging. Managed by provision-postgres.sh.
listen_addresses = '${LISTEN}'
port = 5432

# An HNSW index build over the embedding column is the most memory-hungry thing this
# schema does; the 64MB default makes it crawl or spill.
maintenance_work_mem = 512MB
max_parallel_maintenance_workers = 2

shared_buffers = 512MB
effective_cache_size = 1536MB
work_mem = 16MB

# Hyperdrive pools on its side, so the server does not need a large ceiling.
max_connections = 100

# TLS, using the snakeoil certificate the distribution provides. Replace with a real
# certificate before this database holds anything that matters.
ssl = on

log_min_duration_statement = 2000
log_line_prefix = '%m [%p] %q%u@%d '
CONF

grep -q "conf.d-uxe.conf" "${PG_CONF_DIR}/postgresql.conf" \
  || echo "include_if_exists = 'conf.d-uxe.conf'" >> "${PG_CONF_DIR}/postgresql.conf"

# Local connections only, password-authenticated. Nothing here opens a network path; the
# connection from Cloudflare arrives through the tunnel described at the end.
HBA="${PG_CONF_DIR}/pg_hba.conf"
grep -q "# uxe-staging" "${HBA}" || cat >> "${HBA}" <<HBA_RULES

# uxe-staging — added by provision-postgres.sh
host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32    scram-sha-256
host    ${DB_NAME}    ${DB_USER}    ::1/128         scram-sha-256
HBA_RULES

restart_postgres
wait_for_postgres

# --- 3. Role and database ---------------------------------------------------

log "Creating the role and database"

if [[ -z "${DB_PASSWORD}" ]]; then
  DB_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  GENERATED=1
fi

runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec
SQL

# The extensions must exist inside the database itself, not the cluster.
runuser -u postgres -- psql -v ON_ERROR_STOP=1 -q -d "${DB_NAME}" <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER};
SQL

# --- 4. Verify --------------------------------------------------------------

log "Verifying"
VECTOR_VERSION="$(runuser -u postgres -- psql -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'vector'" -d "${DB_NAME}")"
[[ -n "${VECTOR_VERSION}" ]] || fail "pgvector did not install into ${DB_NAME}"

PGPASSWORD="${DB_PASSWORD}" psql -h 127.0.0.1 -U "${DB_USER}" -d "${DB_NAME}" -tAc \
  "SELECT 'connection ok'" >/dev/null || fail "The ${DB_USER} role cannot connect to ${DB_NAME}"

SERVER_VERSION="$(runuser -u postgres -- psql -tAc "SHOW server_version")"

# --- 5. Report --------------------------------------------------------------

cat <<SUMMARY

  PostgreSQL ${SERVER_VERSION}, pgvector ${VECTOR_VERSION}, database ${DB_NAME} ready.

  Connection string (keep it secret; it is not written to disk by this script):

    postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:5432/${DB_NAME}

SUMMARY

if [[ "${GENERATED:-0}" == "1" ]]; then
  echo "  The password above was generated. Store it now — it is not recoverable from here."
  echo
fi

cat <<'NEXT'
  The database listens on localhost only. To let Cloudflare reach it, pick one:

  A. Private, recommended — Cloudflare Tunnel, database never on the public internet:

       cloudflared tunnel login
       cloudflared tunnel create uxe-staging-db
       cloudflared tunnel route ip add 127.0.0.1/32 uxe-staging-db
       cloudflared tunnel run uxe-staging-db      # then install as a service

     Then create a Workers VPC service from that tunnel and point Hyperdrive at it:

       wrangler hyperdrive create uxe-staging \
         --service-id <VPC_SERVICE_ID> --database uxe_staging \
         --user uxe --password '<PASSWORD>' --scheme postgresql

  B. Public — set LISTEN=0.0.0.0, open 5432 to Cloudflare's published ranges ONLY
     (https://www.cloudflare.com/ips/), install a real TLS certificate, and require
     sslmode=verify-full. Simpler to set up, and a database on the public internet.

NEXT
