# Screens

What each route does, what it looks like at each breakpoint, and what happens in every
state it can reach. Screenshots are in `artifacts/screenshots/`, captured at 1440×900,
1024×768 and 390×844.

## `/login` · Sign in

Split layout: Ayumi and the promise on the left, the form on the right. Below 1024px the
illustration moves above the form; below 768px it becomes a compact header so the form is
above the fold.

- Google and Microsoft SSO, then email and password.
- A magic-link option for customers who prefer not to hold a password.
- MFA is a second step, never a second page: the challenge replaces the form in place.
- `?expired` explains that a session ended rather than presenting a bare form.
- Errors are announced (`role="alert"`), and a rate limit shows the countdown.

## `/register`, `/forgot-password`, `/reset-password`, `/verify-email`, `/accept-invite`

The same shell. Registration creates the organization, workspace and Owner together, so a
new customer is productive immediately rather than configuring tenancy first.

`/accept-invite` previews the invitation — who invited you, to which workspace, as what —
before anything is committed, and asks for a password only when the address has no account.

## `/dashboard`

Four KPI cards (consultations, documents reviewed, compliance rate, evidence coverage),
each deep-linking to the page that explains it. A trend chart, a compliance donut, recent
consultations, and the knowledge-health card.

Three columns at ≥1280px, two at 768–1279px, one below. A brand-new workspace shows zeros
and an empty state that names the next action — never fabricated figures.

## `/consult` and `/consult/:id`

The main workspace, three panes:

| Pane   | Contents                                                                            |
| ------ | ----------------------------------------------------------------------------------- |
| Left   | Consultation history, search, Ayumi's status card                                   |
| Centre | The conversation, the task-mode selector, the composer                              |
| Right  | Evidence and output: answer style, evidence detail toggles, coverage, output format |

Below 1280px the side panes become drawers; below 768px they are sheets reached from the
header, and the composer is pinned above the bottom navigation.

Four task modes: Ask, Summarize, Check compliance, Correct document. Three answer depths,
switchable without re-running the question.

## `/knowledge`

Upload zone with drag-and-drop, connectors and a URL option. A filterable table of sources
with status, type, pages, version, access and owner. The right rail carries the ingestion
pipeline, knowledge health and an "Ask Ayumi about this" shortcut.

States: uploading with real progress, indexing, duplicate (naming the document it matches),
failed (with the reason and a Retry), quarantined (with the matched pattern), needs review.

## `/knowledge/:sourceId`

Overview, versions, permissions and the processing log. Owners and Knowledge Managers can
edit the title, tags, effective date and access scope — the request carries the row version,
so two concurrent edits cannot silently overwrite each other. Quarantine and failure
banners appear above the tabs with the reason in full.

## `/reports` and `/reports/:reportId`

Generated artifacts with their format, size, author and any disclosures — for example that a
corrected edition is an unsigned derivative of a signed original. Downloads are
short-lived signed URLs, never durable public links.

## `/activity`

The audit log: actor, action, target, result, IP, trace reference. Filterable by category,
actor, result and date; exportable as CSV. Append-only, enforced by the database.

## `/users`

Members with their role, groups, MFA state, active sessions and last activity. Invite,
change role, suspend, remove — each gated on a permission the server checks again, and each
audited. Changing a role revokes that member's sessions, so a demotion takes effect
immediately.

## `/settings/*`

| Section    | Contains                                                                             |
| ---------- | ------------------------------------------------------------------------------------ |
| General    | Workspace name, slug, locale, timezone, brand colour, logo                           |
| Consultant | Ayumi's name, title, greeting, behaviour notes, default answer style and task mode   |
| Models     | Provider, capability, model, API key (write-only), default selection                 |
| Security   | MFA policy, session idle and absolute limits, allowed email domains, SSO enforcement |
| Retention  | Consultation, artifact and audit windows, purge grace, legal hold                    |

A stored API key is never returned by any endpoint, to anyone.

## Responsive rules

| Width      | Navigation                              | Columns     |
| ---------- | --------------------------------------- | ----------- |
| ≥ 1280px   | Persistent left rail                    | Up to three |
| 768–1279px | Off-canvas drawer                       | Two         |
| < 768px    | Bottom bar: four destinations plus More | One         |

The page never scrolls horizontally at any width. Wide content scrolls inside its own
container.

## States every screen implements

Loading (skeletons inside a polite live region), empty (with the action that fills it),
success, validation error (bound to the field, announced), permission denied (explaining
what is missing, not a blank page), and failure (with a trace reference and a Retry).
