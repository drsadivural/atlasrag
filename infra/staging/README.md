# Staging database provisioning

`provision-postgres.sh` turns a bare Linux VM into the PostgreSQL instance this
application needs. Run it on the machine that will hold the staging database.

```bash
sudo bash infra/staging/provision-postgres.sh
```

It is idempotent — running it twice is safe and leaves the same result, except
that a second run without `DB_PASSWORD` set rotates the password. Pass one to
keep it stable:

```bash
sudo DB_PASSWORD='<chosen-password>' bash infra/staging/provision-postgres.sh
```

## What it does

1. Installs PostgreSQL 16 and pgvector 0.8.6 from the PGDG repository (apt on
   Debian/Ubuntu, dnf on RHEL/Rocky/Alma).
2. Writes `conf.d-uxe.conf` — its own file, so the distribution's
   `postgresql.conf` is never edited and an upgrade will not fight it.
3. Appends scram-sha-256 host rules to `pg_hba.conf`.
4. Creates the `uxe` role and the `uxe_staging` database, and enables the
   `vector` and `pg_trgm` extensions.
5. Verifies the result and prints the connection string.

The password is generated with `openssl rand`, printed once, and never written
to disk by the script. Store it in a secret manager immediately.

## What it deliberately does not do

The database listens on **localhost only**. Nothing about the script exposes it
to the internet. Once it has run, choose how Cloudflare reaches it — the script
prints both options, and the private one is the recommended default:

- **Cloudflare Tunnel + Workers VPC** (recommended): the database keeps no
  public listener at all; Hyperdrive connects through the tunnel.
- **Public listener restricted to Cloudflare's published IP ranges**: simpler,
  and it puts a database on the public internet. If you take this route, install
  a real TLS certificate and require `sslmode=verify-full`.

## Verified

Exercised end to end on a clean `ubuntu:24.04` host on 2026-08-25:

| Step                                      | Result                                                  |
| ----------------------------------------- | ------------------------------------------------------- |
| Fresh install                             | PostgreSQL 16.15, pgvector 0.8.6, `uxe_staging` created |
| Second run (idempotency)                  | Re-ran clean; `pg_trgm already exists, skipping`        |
| `pnpm --filter @uxe/db migrate`           | `applied 4, already present 0`                          |
| `pnpm --filter @uxe/db seed`              | 7 sources, 5 consultations, 8 audit events              |
| `pnpm smoke` against an API pointed at it | 10/10 checks passed                                     |

The last three rows matter more than the first: they show the script produces a
database this application actually runs on, not merely a PostgreSQL server.

## Hosts without systemd

Service control falls back to `pg_ctlcluster`, then to `pg_ctl`, so the script
also works in a container or on a minimal image where systemd is not PID 1.
That fallback is what made the verification above possible.

## Running staging permanently

Staging is served at **https://consultnow.ayonix.com** through a dedicated named
Cloudflare Tunnel. Four systemd units in `infra/staging/systemd/` hold it up; all four are
enabled, so the whole stack returns after a reboot without anyone logging in.

| Unit                    | What it runs                                                 |
| ----------------------- | ------------------------------------------------------------ |
| `uxe-document-worker`   | the FastAPI extraction service on 127.0.0.1:8099             |
| `uxe-api`               | the API and the in-process job worker on 127.0.0.1:8787      |
| `uxe-web`               | the web server on 127.0.0.1:4173, proxying `/api` to the API |
| `uxe-consultnow-tunnel` | `cloudflared`, the only thing reachable from outside         |

PostgreSQL runs in the `uxe-postgres` container with `--restart unless-stopped`.

Nothing but the tunnel is exposed: the API binds to `API_HOST=127.0.0.1`, and the web
server answers only to the hostname named in `WEB_ALLOWED_HOSTS`. The browser sees one
origin, so the session cookie stays first-party — the same shape production has under
Cloudflare, which is why it is worth the proxy hop.

### Installing or updating the units

```bash
sudo install -m 0644 infra/staging/systemd/*.service /etc/systemd/system/
sudo install -m 0644 infra/staging/systemd/uxe-consultnow.yml /etc/cloudflared/
sudo systemctl daemon-reload
sudo systemctl enable --now uxe-document-worker uxe-api uxe-web uxe-consultnow-tunnel
```

The web server serves a built bundle, so a UI change needs `pnpm --filter @uxe/web build`
followed by `sudo systemctl restart uxe-web`.

### Verified against the live hostname

E2E 49 passed, accessibility 37 passed, and `pnpm smoke` 10/10, all against
`https://consultnow.ayonix.com`.
