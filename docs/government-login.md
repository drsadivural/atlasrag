# Government Edition sign-in

The screen at `/login`. Two reference renderings are held in `artifacts/references/` and
are the visual target; the page reproduces them from semantic markup and design tokens,
and neither screenshot is used as an image anywhere in the product.

## What is on it

| Region         | Contents                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Header         | the geometric UXE mark, the product name, a gold rule, "Government Edition", language, accessibility and help                                   |
| Hero           | the claim, the promise, the restricted badge, the unity lines, three feature cards, the accountability line, and the approved desert photograph |
| Authentication | UAE PASS, Government SSO, a disclosure holding email and password, the provisioning note, four footer links and the security statement          |

Both themes and both languages render from one set of components. There is no second copy
of the page for dark and none for Arabic: direction follows the locale, spacing is written
in logical properties, and colour comes from tokens.

## The rule that shapes the authentication

**This screen never creates an account.** Access is provisioned by an entity
administrator, so:

- there is no registration link anywhere on the page;
- a UAE PASS or Government SSO identity that does not already correspond to a provisioned,
  active user is refused, however well the provider proved who they are;
- every refusal — no address, wrong domain, no such user, suspended, no workspace — is the
  same generic response to the browser, and the specific reason is a structured security
  event in the log instead.

## Providers, and failing closed

A provider is available only when **every** part of its configuration is present. A
partially configured provider counts as absent, because an enabled button that fails at
the redirect is worse for the person pressing it than a disabled one that names what is
missing.

`GET /api/v1/auth/government/config` tells the browser only whether each button works and,
when it does not, which environment variables an administrator must set. No client id, no
endpoint and no secret ever reaches the browser.

### UAE PASS

Standard OpenID Connect authorization code with PKCE.

1. `POST /auth/government/uae-pass/start` mints `state`, `nonce` and a code verifier,
   stores them server-side against a single-use token, and returns the authorization URL.
2. The provider redirects to `/auth/government/uae-pass/callback`.
3. The state is consumed — once, so a replayed callback cannot mint a session.
4. The code is exchanged server-side. The client secret goes in the Basic header and never
   leaves the server.
5. The id token's `nonce`, `iss` and `aud` are checked against what this server issued and
   was configured with. Identity itself comes from the userinfo endpoint over TLS, not from
   an unverified token body.
6. The address is checked against the domain allowlist, then against provisioned users.
7. A session is issued and rotated, and the sign-in is written to the workspace audit log.

Configure with an OAuth client registered for this deployment:

```
UAE_PASS_ENVIRONMENT=staging
UAE_PASS_ISSUER=https://stg-id.uaepass.ae
UAE_PASS_AUTHORIZATION_ENDPOINT=https://stg-id.uaepass.ae/idshub/authorize
UAE_PASS_TOKEN_ENDPOINT=https://stg-id.uaepass.ae/idshub/token
UAE_PASS_USERINFO_ENDPOINT=https://stg-id.uaepass.ae/idshub/userinfo
UAE_PASS_CLIENT_ID=
UAE_PASS_CLIENT_SECRET=
```

The redirect URI to register is:

```
https://<your host>/api/v1/auth/government/uae-pass/callback
```

Production uses the same variables pointed at the production host and
`UAE_PASS_ENVIRONMENT=production`.

### Government SSO

The Microsoft OIDC adapter the product already uses, narrowed for government access: a
tenant allowlist, a domain allowlist and the same provisioned-only rule. An empty tenant
allowlist accepts **no** tenant, so it fails closed rather than open.

```
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
MICROSOFT_OAUTH_TENANT=common
GOV_SSO_ALLOWED_TENANTS=<directory id>
```

Redirect URI: `https://<your host>/api/v1/auth/government/sso/callback`

## Themes, language and accessibility preferences

Theme resolves in order: an explicit saved choice, then the operating system, then light.
The choice is an attribute on the document element written before paint, so there is no
flash of the wrong theme.

The accessibility button opens a real modal — focus trapped, Escape closes, focus returns
to the trigger — offering theme, text size, high contrast, reduced motion and a reset.
Text size scales the root font size, which is why the page is measured in rem throughout.
Reduced motion is honoured from the OS and from the panel, so somebody who cannot change
an OS setting still has the choice.

Only presentation is stored: `{ locale, textSize, contrast, motion }`. Nothing about a
person, an entity or a session is written to the browser.

## Claims this page will not make

Data residency appears in the security statement **only** when
`GOV_DATA_RESIDENCY_STATEMENT=true`. Unset, the line reads "Encrypted session • Monitored
access" and stops there. No certification is claimed on the page at all, and the security
page says so in as many words.

The decorative strokes in the hero are decoration. They are asymmetric, unequal in weight
and carry no emblem; no seal, coat of arms or government logo appears anywhere.

## What is tested, and what is not

| Layer                                           | Covers                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/uae-pass.test.ts`                   | fail-closed configuration, PKCE, nonce, allowlists, no provider message carried to the browser                                                         |
| `tests/component/government-login.test.tsx`     | provider order, disabled providers, validation, password reveal, disclosure state retention, language and RTL, the accessibility panel, the help panel |
| `tests/integration/government.test.ts`          | the config endpoint's silence about secrets, refusal to start an unconfigured flow, forged and replayed callbacks                                      |
| `tests/e2e/government-login.spec.ts`            | the screen in a browser: provider messaging, Arabic RTL across a reload, preference persistence, keyboard-only sign-in, footer routes                  |
| `tests/accessibility/axe.spec.ts`               | axe over light and dark, English and Arabic                                                                                                            |
| `tests/accessibility/government-visual.spec.ts` | 1680×945 in all four combinations, plus 1440×900, 1024×768, 768×1024 and 390×844, each asserting no sideways scroll                                    |

**Not tested: the live handshake with UAE PASS or with an Entra directory.** This
deployment has no registered application for either, so no request has ever reached them.
Everything on this side of the wire is covered; the handshake stands on this document
until the credentials above exist.

## Type scale and the text-size preference

The page is measured in rem so the accessibility panel's text size moves everything.
Measured on the live screen at 1680×945:

| Element                    | Default (16px root) | Large (18px) | Extra large (20px) |
| -------------------------- | ------------------- | ------------ | ------------------ |
| Hero heading               | 58px                | 65.25px      | 72.5px             |
| Hero promise               | 17px                | 19.13px      | 21.25px            |
| Card heading               | 28px                | 31.5px       | 35px               |
| Eyebrow                    | 11px                | 12.38px      | 13.75px            |
| Field labels, footer links | 13px                | 14.63px      | 16.25px            |
| Inputs, primary button     | 15px                | 16.88px      | 18.75px            |
| Security statement         | 12px                | 13.5px       | 15px               |

Every step is exactly +12.5% and +25%, because the root font size is what the preference
scales and nothing on the page is sized in pixels.

The heading steps down where the hero column narrows — 50px from 1280px wide, 40px from
640px, 36px below that — and those steps are in rem too, so the preference still applies
at every width. **This is why the type ladder is not `clamp()` with a `vw` term**: a
viewport unit does not grow with the root font size, so a fluid heading silently caps
itself the moment somebody asks for larger text. The first implementation did exactly
that, and Extra large moved the hero promise by 10% instead of 25%.
