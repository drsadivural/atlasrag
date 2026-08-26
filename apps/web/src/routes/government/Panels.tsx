import { useEffect, useRef, type ReactNode } from 'react';
import {
  ExternalLink,
  KeyRound,
  LifeBuoy,
  Fingerprint,
  Building2,
  Activity,
  ShieldAlert,
  X,
} from 'lucide-react';
import { useI18n } from '../../lib/i18n.js';
import { usePreferences } from '../../lib/preferences.js';
import { useTheme } from '../../lib/theme.js';
import type { ThemePreference } from '@uxe/contracts';

/**
 * A modal that behaves like one.
 *
 * Focus moves in on open and back to the trigger on close, Escape and an outside click
 * both dismiss, and Tab cycles inside. Written here rather than reusing the product's
 * dialog because these panels sit on the government surface and take its tokens, and
 * because a sign-in screen should not pull the whole application's overlay stack in
 * before anybody has authenticated.
 */
function Modal({
  open,
  onClose,
  title,
  children,
  labelledBy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  labelledBy: string;
}) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>('[data-autofocus], button, [href], input')?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;

      const focusable = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-[rgb(6_10_20/55%)]" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className="relative w-full max-w-[26rem] rounded-[0.875rem] border border-[var(--gov-card-border)] bg-[var(--gov-card)] p-5 shadow-[var(--gov-card-shadow)]"
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={labelledBy} className="text-[1.0625rem] font-semibold text-[var(--gov-text)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="-me-1 -mt-1 rounded-[0.5rem] p-1.5 text-[var(--gov-text-secondary)] hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
          >
            <X className="h-4 w-4" aria-hidden />
            <span className="sr-only">{t('common.close')}</span>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="mb-4 border-0 p-0">
      <legend className="mb-2 text-[0.8125rem] font-semibold text-[var(--gov-text)]">
        {legend}
      </legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

function Choice({
  name,
  value,
  current,
  label,
  onSelect,
}: {
  name: string;
  value: string;
  current: string;
  label: string;
  onSelect: () => void;
}) {
  const selected = value === current;
  return (
    <label
      className={[
        'relative cursor-pointer rounded-[0.5rem] border px-3 py-2 text-[0.8125rem] font-medium transition-colors',
        'focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--gov-focus)]',
        selected
          ? 'border-[var(--gov-primary)] bg-[var(--gov-primary)] text-[var(--gov-primary-text)]'
          : 'border-[var(--gov-field-border)] text-[var(--gov-text)] hover:border-[var(--gov-field-border-hover)]',
      ].join(' ')}
    >
      {/* Transparent and stretched over the whole control rather than `sr-only`: a
          zero-sized input is invisible to a pointer as well as to the eye, which makes
          the choice unclickable for anything driving the page. */}
      <input
        type="radio"
        name={name}
        value={value}
        checked={selected}
        onChange={onSelect}
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      />
      <span aria-hidden>{label}</span>
    </label>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 h-4 w-4 accent-[var(--gov-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
      />
      <span>
        <label
          htmlFor={id}
          className="block cursor-pointer text-[0.8125rem] font-semibold text-[var(--gov-text)]"
        >
          {label}
        </label>
        <span id={`${id}-hint`} className="block text-[0.75rem] text-[var(--gov-text-secondary)]">
          {hint}
        </span>
      </span>
    </div>
  );
}

export function AccessibilityPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { preference, setPreference } = useTheme();
  const preferences = usePreferences();

  return (
    <Modal open={open} onClose={onClose} title={t('gov.a11yTitle')} labelledBy="gov-a11y-title">
      <Fieldset legend={t('gov.a11yTheme')}>
        {(
          [
            ['light', t('gov.a11yThemeLight')],
            ['dark', t('gov.a11yThemeDark')],
            ['system', t('gov.a11yThemeSystem')],
          ] as Array<[ThemePreference, string]>
        ).map(([value, label]) => (
          <Choice
            key={value}
            name="gov-theme"
            value={value}
            current={preference}
            label={label}
            onSelect={() => setPreference(value)}
          />
        ))}
      </Fieldset>

      <Fieldset legend={t('gov.a11yTextSize')}>
        {(
          [
            ['default', t('gov.a11yTextDefault')],
            ['large', t('gov.a11yTextLarge')],
            ['xlarge', t('gov.a11yTextXLarge')],
          ] as const
        ).map(([value, label]) => (
          <Choice
            key={value}
            name="gov-text-size"
            value={value}
            current={preferences.textSize}
            label={label}
            onSelect={() => preferences.set('textSize', value)}
          />
        ))}
      </Fieldset>

      <Toggle
        id="gov-contrast"
        label={t('gov.a11yContrast')}
        hint={t('gov.a11yContrastHint')}
        checked={preferences.contrast === 'high'}
        onChange={(next) => preferences.set('contrast', next ? 'high' : 'default')}
      />
      <Toggle
        id="gov-motion"
        label={t('gov.a11yMotion')}
        hint={t('gov.a11yMotionHint')}
        checked={preferences.motion === 'reduced'}
        onChange={(next) => preferences.set('motion', next ? 'reduced' : 'system')}
      />

      <button
        type="button"
        onClick={() => {
          preferences.reset();
          setPreference('system');
        }}
        className="w-full rounded-[0.5rem] border border-[var(--gov-field-border)] px-3 py-2.5 text-[0.8125rem] font-semibold text-[var(--gov-text)] hover:border-[var(--gov-field-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
      >
        {t('gov.a11yReset')}
      </button>
    </Modal>
  );
}

export interface HelpLinks {
  support: string;
  status: string;
  incident: string;
  uaePassHelp: string;
  ssoHelp: string;
}

export function HelpPanel({
  open,
  onClose,
  links,
  onRecoverPassword,
}: {
  open: boolean;
  onClose: () => void;
  links: HelpLinks;
  onRecoverPassword: () => void;
}) {
  const { t } = useI18n();

  const entries: Array<{ icon: ReactNode; label: string; href?: string; onClick?: () => void }> = [
    {
      icon: <Fingerprint className="h-4 w-4" aria-hidden />,
      label: t('gov.helpUaePass'),
      href: links.uaePassHelp,
    },
    {
      icon: <Building2 className="h-4 w-4" aria-hidden />,
      label: t('gov.helpSso'),
      href: links.ssoHelp,
    },
    {
      icon: <KeyRound className="h-4 w-4" aria-hidden />,
      label: t('gov.helpRecovery'),
      onClick: onRecoverPassword,
    },
    {
      icon: <LifeBuoy className="h-4 w-4" aria-hidden />,
      label: t('gov.helpContact'),
      href: links.support,
    },
    {
      icon: <Activity className="h-4 w-4" aria-hidden />,
      label: t('gov.helpStatus'),
      href: links.status,
    },
    {
      icon: <ShieldAlert className="h-4 w-4" aria-hidden />,
      label: t('gov.helpIncident'),
      href: links.incident,
    },
  ];

  return (
    <Modal open={open} onClose={onClose} title={t('gov.helpTitle')} labelledBy="gov-help-title">
      <section className="mb-4 rounded-[0.5rem] border border-[var(--gov-card-border)] bg-[var(--gov-panel)] p-3">
        <h3 className="text-[0.8125rem] font-semibold text-[var(--gov-text)]">
          {t('gov.helpSignIn')}
        </h3>
        <p className="mt-1 text-[0.8125rem] text-[var(--gov-text-secondary)]">
          {t('gov.helpSignInBody')}
        </p>
      </section>

      <ul className="flex flex-col gap-1">
        {entries
          // A destination this deployment has not configured is left out rather than
          // rendered as a link to nowhere.
          .filter((entry) => entry.onClick || entry.href)
          .map((entry) => (
            <li key={entry.label}>
              {entry.onClick ? (
                <button
                  type="button"
                  onClick={entry.onClick}
                  className="flex w-full items-center gap-2.5 rounded-[0.5rem] px-2.5 py-2 text-start text-[0.8125rem] font-medium text-[var(--gov-text)] hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
                >
                  {entry.icon}
                  {entry.label}
                </button>
              ) : (
                <a
                  href={entry.href}
                  {...(isExternal(entry.href ?? '')
                    ? { target: '_blank', rel: 'noopener noreferrer' }
                    : {})}
                  className="flex items-center gap-2.5 rounded-[0.5rem] px-2.5 py-2 text-[0.8125rem] font-medium text-[var(--gov-text)] hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
                >
                  {entry.icon}
                  {entry.label}
                  {isExternal(entry.href ?? '') && (
                    <>
                      <ExternalLink className="h-3.5 w-3.5 opacity-70" aria-hidden />
                      <span className="sr-only">{t('gov.externalLink')}</span>
                    </>
                  )}
                </a>
              )}
            </li>
          ))}
      </ul>
    </Modal>
  );
}

function isExternal(href: string): boolean {
  return /^https?:\/\//i.test(href);
}
