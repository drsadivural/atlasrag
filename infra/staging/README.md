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

## Who can reach it

Nothing stands in front of the hostname: the way in is the product's own sign-up and
sign-in. Anyone with the URL can create an account and gets their own organization and
workspace, isolated from every other tenant. That is the right shape for a staging
environment people are meant to try, and the wrong one for anything with real client
material in it.

The `WEB_BASIC_AUTH` plugin is still available if a lock is wanted again — set it to
`user:password` on the web unit and it covers the pages and the API together, leaving
loopback alone for the verification suites. Access is the better answer; see below.

## Putting Cloudflare Access in front of it

The staging hostname is on the public internet and the seeded demo account is documented
in this repository, so anyone holding the URL can sign in. Access closes that.

```bash
CLOUDFLARE_API_TOKEN=... bash infra/staging/apply-access.sh
```

The script is idempotent — it creates the application or updates the existing one — and
takes its policy from the environment:

| Variable                 | Default                 |
| ------------------------ | ----------------------- |
| `ACCESS_HOSTNAME`        | `consultnow.ayonix.com` |
| `ACCESS_ALLOWED_DOMAINS` | `ayonix.com`            |
| `ACCESS_ALLOWED_EMAILS`  | `drsadivural@gmail.com` |

**The token needs permissions a default one does not have.** Add both:

- Account → **Access: Apps and Policies** → **Edit**
- Account → **Access: Organizations, Identity Providers, and Groups** → **Read**

Reading applications succeeds without them, so a token that can list Access apps may
still fail to create one — that failure is `1010 auth.forbidden`, and the script says so
rather than leaving you to guess. If the account has never had Zero Trust set up at all,
that is a one-time step in the dashboard first; no API token can do it.

With no identity provider configured, Access falls back to its own one-time PIN, so an
allowed address simply receives a code by email.

Once Access is on, anything automated hitting the public hostname meets the login page.
Either give it a service token with its own policy, or point it at `127.0.0.1:4173` —
same stack, just upstream of the tunnel:

```bash
SMOKE_API=http://127.0.0.1:4173/api/v1 SMOKE_WEB=http://127.0.0.1:4173 pnpm smoke
```

## Cloudflare Access

`apply-access.sh` puts an Access application in front of a hostname, or in front of one
path on it. The token needs two permission groups that are not in a default API token:

    Account -> Access: Apps and Policies                         -> Edit
    Account -> Access: Organizations, Identity Providers, Groups -> Read

With no identity provider configured, Access falls back to its own one-time PIN: an
allowed address receives a code by email, and nothing else has to be set up.

### What is protected, and why only that

    CLOUDFLARE_API_TOKEN=... \
    ACCESS_HOSTNAME='consultnow.ayonix.com/api/v1/metrics' \
    ACCESS_APP_NAME='UXE Consulting AI — metrics' \
    bash infra/staging/apply-access.sh

The metrics endpoint answered request volumes, route names and latencies to anybody who
asked on a public hostname. That is operational intelligence and it is now behind Access.

The application itself is deliberately **not** fronted. It was going to be, back when the
staging site had no accounts of its own and a shared password was the only door. It has
accounts now: public registration, invitations emailed to addresses outside the
organisation, and password-reset links. An Access policy in front of the whole hostname
would stop every one of those at a login page belonging to a different system — the invited
person cannot accept, because being invited is exactly the state of not being on the
allowlist yet.

Fronting the whole hostname is one command when it is the right thing, and the sentence
above is the reason to think about it first:

    ACCESS_HOSTNAME='consultnow.ayonix.com' bash infra/staging/apply-access.sh
