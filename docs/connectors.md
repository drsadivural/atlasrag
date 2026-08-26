# Connectors

A workspace can attach Google Drive, OneDrive or SharePoint. Files from a connected
account become ordinary sources — indexed, retrieved, cited and correctable by exactly the
same paths as a document dragged into the browser. Nothing about arriving from Drive makes
a document a second class of thing once it is here.

Access is **read-only**. The scopes requested are `drive.readonly` for Google and
`Files.Read.All` / `Sites.Read.All` for Microsoft; nothing is ever written back to the
connected account.

## Two separate states

Whether a **deployment** can offer a provider and whether a **workspace** has connected one
are different questions with different answers and different people to fix them:

| State         | Who fixes it            | How                                                          |
| ------------- | ----------------------- | ------------------------------------------------------------ |
| Needs setup   | operator                | register an OAuth application, set two environment variables |
| Not connected | workspace administrator | Settings → Connectors → Connect                              |
| Connected     | —                       | Sync now, or from the knowledge base                         |

The settings screen shows all three distinctly, and names the missing environment
variables and the exact redirect URI rather than presenting a disabled button.

## Registering the OAuth applications

Both providers need one application per deployment, and both must have this redirect URI
registered **exactly**:

```
https://consultnow.ayonix.com/api/v1/connectors/callback
```

**Google** — Google Cloud Console → APIs & Services → Credentials → OAuth client ID (Web
application). Enable the Google Drive API, add the `drive.readonly` scope, then set:

```
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
```

**Microsoft** — Azure Portal → App registrations → New registration. Add the delegated
Microsoft Graph permissions `Files.Read.All` and `Sites.Read.All`, then set:

```
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_TENANT=common
```

One Microsoft application serves both OneDrive and SharePoint.

## How a connection is held

The consent flow mints a single-use state token carrying the workspace, so the callback —
which arrives from the provider with no session of ours — does not have to trust a cookie,
and a replayed callback cannot attach a second grant.

Google returns a refresh token only for `access_type=offline`, and only on first consent
unless `prompt=consent` forces the screen again. Both are set, and a callback that comes
back without a refresh token is **refused**: recording a connection that stops working
within the hour would be worse than not connecting at all.

The refresh token is AES-256-GCM encrypted with `ENCRYPTION_KEY` and read by exactly one
method, `credentialFor`, which the sync worker calls. No repository method that returns
whole connector rows selects it, so it cannot reach an API response by accident.
Disconnecting clears it in the same statement as the soft delete.

## What a sync does

1. Trades the refresh token for a short-lived access token.
2. Lists files, page by page, excluding folders and trashed items. Google listings span
   shared drives, which is where a consultancy keeps client material.
3. Skips anything the document worker cannot read, or larger than 100MB, and **names** what
   it skipped — a count alone tells nobody which file to go and look at.
4. Downloads the rest and hashes the content. A file already present at the same hash is
   left alone, so re-running a sync does not multiply the library and a renamed but
   unchanged file is recognised as the same document.
5. Creates a source and enqueues the ordinary ingest job for each new file.

A run stops after 200 files and says so, rather than truncating silently. One unreadable
file is recorded and skipped; it does not abandon the rest of the account.

A revoked grant is recorded on the connector as an error with the reason shown on its
card, because that is a state only the account holder can clear.

## Testing

The provider APIs cannot be reached from a deployment with no OAuth application, so the
split is deliberate:

- `tests/unit/file-store.test.ts` drives both clients against a stubbed fetch: which URL,
  which parameters, how each provider's response shape is read, and which failures are
  worth retrying.
- `tests/integration/connectors.test.ts` runs the whole sync against a stubbed provider on
  a harness configured with an OAuth application, and asserts on what lands in the
  knowledge base: imported, skipped, deduplicated, and the status recorded afterwards.

What neither can prove is the live handshake with Google or Microsoft. That needs a
registered application, and it is the one part of this feature that stays unverified until
the credentials above exist.
