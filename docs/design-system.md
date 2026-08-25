# Design system

The visual language of UXE Consulting AI, and the reasoning behind the parts that are not
arbitrary.

## Tokens

Every colour, radius, shadow and duration is a CSS custom property defined in
`packages/ui/src/tokens.css`, and exposed to Tailwind through `apps/web/src/styles.css`. Components reference tokens, never literals, which is what makes
the dark theme a redefinition of variables rather than a second stylesheet.

### Colour

| Token                  | Light                                      | Role                                |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `--uxe-bg`             | `#F8FAFF`                                  | Page background                     |
| `--uxe-surface`        | `#FFFFFF`                                  | Cards, panels, table rows           |
| `--uxe-surface-sunken` | `#F4F7FE`                                  | Wells, inactive segments            |
| `--uxe-text`           | `#10162F`                                  | Primary text                        |
| `--uxe-text-secondary` | `#5F6876`                                  | Secondary text                      |
| `--uxe-cobalt`         | `#3156F5`                                  | Primary action                      |
| `--uxe-violet`         | `#7C3AED`                                  | Gradient terminus                   |
| `--uxe-gradient`       | `linear-gradient(90deg, #3156F5, #7C3AED)` | Brand surfaces                      |
| `--uxe-success`        | `#0A7A4D`                                  | Compliant                           |
| `--uxe-warning`        | `#F59E0B`                                  | Needs evidence, partial             |
| `--uxe-danger`         | `#C1272D`                                  | Non-compliant, destructive          |
| `--uxe-info`           | `#2563EB`                                  | Neutral information                 |
| `--uxe-teal`           | `#0EA5A8`                                  | Project documents, secondary accent |

Each status colour also has a `-text` variant (`--uxe-success-text`, `--uxe-warning-text`,
`--uxe-danger-text`, `--uxe-info-text`, `--uxe-teal-text`) used for labels on the matching
tint. The accent alone is around 2.8:1 there, which is fine for a dot or an icon and not
fine for an 11px word; the axe scan asserts the difference.

Status is never conveyed by colour alone. Every badge carries a word, and most carry an
icon as well — a reader with a colour-vision difference gets the same information as anyone
else.

### Shape and rhythm

| Token                     | Value | Applies to              |
| ------------------------- | ----- | ----------------------- |
| `--uxe-radius-card`       | 14px  | Cards, dialogs, panels  |
| `--uxe-radius-control`    | 10px  | Inputs, buttons, badges |
| `--uxe-radius-control-lg` | 12px  | Segmented groups, menus |
| `--uxe-radius-pill`       | 999px | Pills, confidence chips |

Spacing is a 4px scale. Body text is 15–16px; no interactive control drops below 13px.

### Motion

| Token                 | Value                        |
| --------------------- | ---------------------------- |
| `--uxe-duration-fast` | 150ms                        |
| `--uxe-duration`      | 180ms                        |
| `--uxe-duration-slow` | 220ms                        |
| `--uxe-ease`          | `cubic-bezier(0.2, 0, 0, 1)` |

All of it collapses to near-zero under `prefers-reduced-motion: reduce`. Motion is used to
explain a change of state, never for decoration.

## Typography

Inter, self-hosted through `@fontsource-variable/inter`. No network request for a font, so
nothing about the user's session leaks to a font CDN and there is no flash of unstyled text.

Numerals in tables and metrics use `tabular-nums` so columns align and a changing figure
does not shift its neighbours.

## Components

Built on Radix primitives, which own focus trapping, roving focus, escape handling and ARIA
semantics. What the design system adds is the product's own shape and behaviour:

- **Button** — six variants, five sizes; `loading` disables and announces `aria-busy`;
  `asChild` renders a link without nesting interactive elements.
- **Field** — binds the label, hint and error to the control itself. The control receives
  `aria-invalid`, `aria-required` and `aria-describedby` automatically, so a red border is
  never the only signal that something is wrong.
- **SegmentedControl** — a radio group. Arrow keys move the selection, not just the focus,
  which is what a radio group is expected to do.
- **DataTable** — a table on desktop, one labelled card per row below `md`. Clickable rows
  carry a real focusable control in the primary cell, because a row that only responds to a
  click cannot be reached by keyboard.
- **EmptyState / ErrorState / LoadingRegion** — the three non-success states, each with a
  way forward: an action, a retry with a trace reference, or a polite announcement.
- **Toast** — successes auto-dismiss; errors do not. A failure the user has not read must
  not disappear on a timer.

## Layout

| Width      | Navigation                              | Content             |
| ---------- | --------------------------------------- | ------------------- |
| ≥ 1280px   | Persistent left rail                    | Up to three columns |
| 768–1279px | Off-canvas drawer                       | Two columns         |
| < 768px    | Bottom bar: four destinations plus More | One column          |

The page itself never scrolls horizontally at any width. Wide content — evidence matrices,
code, diagrams — scrolls inside its own container.

## Ayumi

The consultant's portrait (`assets/consultantgirl.png`) appears on the sign-in screen, in
the consultation header and beside her messages. It is always `object-fit: contain` inside
a fixed frame, and it never overlaps a control: the illustration is presence, not chrome.

## Dark theme

Semantic tokens are redefined under `prefers-color-scheme: dark` and under an explicit
`[data-theme='dark']`, so the system preference is honoured and an explicit choice still wins. Because components reference
roles rather than colours, no component contains a dark-mode branch. Contrast is verified at
AA in both themes.

## Accessibility commitments

- Visible focus on every interactive element, in both themes.
- Touch targets at least 44×44px.
- Landmarks: one `main`, uniquely named navigation regions, a skip link as the first tab
  stop.
- Live regions for status, progress and errors.
- Every icon is either labelled or `aria-hidden` with adjacent text.

These are asserted, not asserted-to: `pnpm test:a11y` scans every route with axe at WCAG 2.2
AA and drives the product with the keyboard alone.
