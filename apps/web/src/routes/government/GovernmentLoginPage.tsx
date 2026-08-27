import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Accessibility, CircleHelp, FileCheck2, Globe, Languages, ShieldCheck } from 'lucide-react';
import { useI18n } from '../../lib/i18n.js';
import { usePreferences } from '../../lib/preferences.js';
import { useTheme } from '../../lib/theme.js';
import { AuthCard } from './AuthCard.js';
import { GovernmentMark, UnityLines } from './Decoration.js';
import { AccessibilityPanel, HelpPanel } from './Panels.js';
import { fetchGovernmentConfig, type GovernmentConfig } from './config.js';

/**
 * Government Edition sign-in.
 *
 * Two regions on one grid: the hero carries the service's claim about itself, the panel
 * carries the way in. Both themes and both languages render from this same markup — there
 * is no second copy of the page for dark, and none for Arabic. Direction comes from the
 * locale and spacing is written in logical properties, so the layout mirrors rather than
 * being re-authored.
 */
export function GovernmentLoginPage() {
  const [accessibilityOpen, setAccessibilityOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // The screen renders and works while this is in flight; the federated buttons simply
  // stay disabled until the deployment has answered for them.
  const { data: config } = useQuery<GovernmentConfig>({
    queryKey: ['government-config'],
    queryFn: fetchGovernmentConfig,
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <div
      data-surface="government"
      className="flex min-h-dvh flex-col bg-[var(--gov-page)] [padding-bottom:env(safe-area-inset-bottom)]"
    >
      <GovernmentHeader
        onAccessibility={() => setAccessibilityOpen(true)}
        onHelp={() => setHelpOpen(true)}
      />

      {/* Column-reverse below the breakpoint puts authentication first on a phone while
          keeping the hero first in the document for everyone else. */}
      <main
        id="main"
        className="flex flex-1 flex-col-reverse lg:grid lg:grid-cols-[44fr_56fr] xl:grid-cols-[60fr_40fr]"
      >
        <Hero />

        <section
          aria-labelledby="gov-signin-heading"
          className="flex items-center justify-center bg-[var(--gov-panel)] px-4 py-10 [color-scheme:light] sm:px-8 lg:px-10"
        >
          {/* Named by the card's own heading rather than by a duplicate for screen
              readers: two elements with the same name is one more than a page needs. */}
          <AuthCard config={config ?? null} onNeedHelp={() => setHelpOpen(true)} />
        </section>
      </main>

      <AccessibilityPanel open={accessibilityOpen} onClose={() => setAccessibilityOpen(false)} />
      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        links={{
          support: config?.links.support ?? '/support',
          status: config?.links.status ?? '',
          incident: config?.links.incident ?? '',
          uaePassHelp: config?.links.uaePassHelp ?? '',
          ssoHelp: config?.links.ssoHelp ?? '',
        }}
        onRecoverPassword={() => {
          setHelpOpen(false);
          window.location.assign('/forgot-password');
        }}
      />
    </div>
  );
}

function GovernmentHeader({
  onAccessibility,
  onHelp,
}: {
  onAccessibility: () => void;
  onHelp: () => void;
}) {
  const { t, locale } = useI18n();
  const { set } = usePreferences();

  return (
    <header className="flex h-[4.75rem] shrink-0 items-center justify-between border-b border-[var(--gov-header-border)] bg-[var(--gov-header)] px-4 sm:px-8 lg:px-[3.75rem]">
      <div className="flex min-w-0 items-center gap-3">
        <GovernmentMark className="h-7 w-auto shrink-0 select-none" />
        <span className="truncate text-[1.0625rem] font-bold text-[var(--gov-header-text)] sm:text-[1.1875rem]">
          {t('gov.brand')}
        </span>
        <span className="hidden h-5 w-px bg-[var(--gov-gold)] opacity-60 sm:block" aria-hidden />
        <span className="hidden text-[0.9375rem] font-semibold text-[var(--gov-gold-text)] sm:block">
          {t('gov.edition')}
        </span>
      </div>

      <nav aria-label={t('gov.utilities')} className="flex items-center gap-1 sm:gap-2">
        <div className="hidden items-center gap-1 sm:flex">
          <Globe className="h-4 w-4 text-[var(--gov-header-text)] opacity-70" aria-hidden />
          <LanguageButton
            label={t('gov.english')}
            active={locale !== 'ar'}
            onClick={() => set('locale', 'en')}
          />
          <Divider />
          <LanguageButton
            label={t('gov.arabic')}
            active={locale === 'ar'}
            onClick={() => set('locale', 'ar')}
          />
          <Divider />
        </div>

        {/* Below `sm` the two languages collapse into one toggle so the header never
            wraps and the brand stays readable. */}
        <button
          type="button"
          onClick={() => set('locale', locale === 'ar' ? 'en' : 'ar')}
          className="flex h-10 items-center gap-1.5 rounded-full px-2.5 text-[0.8125rem] font-semibold text-[var(--gov-header-text)] hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)] sm:hidden"
        >
          <Languages className="h-4 w-4" aria-hidden />
          <span aria-hidden>{locale === 'ar' ? 'EN' : 'ع'}</span>
          {/* Named for what it switches to, so the control announces its effect and reads
              the same to a person and to a test whatever the viewport. */}
          <span className="sr-only">{locale === 'ar' ? t('gov.english') : t('gov.arabic')}</span>
        </button>

        <IconButton label={t('gov.accessibility')} onClick={onAccessibility}>
          <Accessibility className="h-[1.125rem] w-[1.125rem]" aria-hidden />
        </IconButton>
        <Divider />
        <IconButton label={t('gov.help')} onClick={onHelp}>
          <CircleHelp className="h-[1.125rem] w-[1.125rem]" aria-hidden />
        </IconButton>
      </nav>
    </header>
  );
}

function Divider() {
  return <span className="h-5 w-px bg-[var(--gov-divider)]" aria-hidden />;
}

function LanguageButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={[
        'rounded-[0.375rem] px-2.5 py-1.5 text-[0.875rem] transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]',
        active
          ? 'font-semibold text-[var(--gov-header-text)]'
          : 'font-medium text-[var(--gov-header-text)] opacity-70 hover:opacity-100',
      ].join(' ')}
    >
      {label}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="flex h-10 w-10 items-center justify-center rounded-full border border-[var(--gov-divider)] text-[var(--gov-header-text)] transition-colors hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function Hero() {
  const { t } = useI18n();
  const { resolved } = useTheme();

  // Art direction, not a filter: the night frame and the day frame are separate
  // photographs of the same place, and the theme decides which one belongs behind the
  // words. Only the active one is fetched.
  const image = resolved === 'dark' ? '/login-desert-night.webp' : '/login-desert-day.webp';

  return (
    <section className="relative isolate flex min-h-[26rem] flex-col justify-between overflow-hidden px-6 py-8 sm:px-10 lg:min-h-0 lg:px-8 lg:py-8 xl:px-[3.75rem] xl:py-10">
      <div
        aria-hidden
        className="absolute inset-0 -z-20"
        style={{ background: 'var(--gov-hero)' }}
      />
      {/*
        Anchored to the bottom at its own aspect rather than stretched to cover: covering
        a 16:9 photograph into a portrait column magnifies the consultant to twice the
        scale the approved references show her at. Contained and bottom-aligned, she
        stands in the frame at the intended size and the ground above her is the hero's
        own gradient.
      */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10">
        <img
          src={image}
          alt=""
          width={1672}
          height={941}
          fetchPriority="high"
          decoding="async"
          className="w-full select-none"
          draggable={false}
        />
        {/* On the photograph's own top edge rather than at a percentage of the hero, so
            the blend stays put whatever the column measures. */}
        <div className="absolute inset-x-0 top-0 h-[38%] bg-[linear-gradient(180deg,var(--gov-hero-fade)_0%,transparent_100%)]" />
      </div>
      {/* Carries the contrast for the words on the reading side while leaving the
          consultant clear, and blends the top of the photograph into the ground. */}
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[linear-gradient(96deg,var(--gov-hero-scrim-strong)_0%,var(--gov-hero-scrim-mid)_46%,transparent_78%)] rtl:bg-[linear-gradient(264deg,var(--gov-hero-scrim-strong)_0%,var(--gov-hero-scrim-mid)_46%,transparent_78%)]"
      />
      {/* Dropped below xl: in a narrower hero the strokes have nowhere to run without
          crossing the restricted badge, and decoration is the right thing to give up when
          space is short. */}
      <UnityLines className="pointer-events-none absolute end-0 top-[18%] -z-10 hidden h-[16rem] w-[62%] opacity-90 xl:block" />

      {/*
        Stepped in rem rather than sized with `vw`. A viewport unit does not grow with the
        root font size, so it silently caps the heading the moment somebody asks for larger
        text — the accessibility preference has to win, and only a rem ladder lets it.
        The steps carry the reference size at the reference width and reduce it where the
        hero column narrows.
      */}
      <div className="max-w-[37.5rem]">
        <h1 className="text-[2.25rem] leading-[1.06] font-bold tracking-[-0.02em] text-balance text-[var(--gov-hero-text)] sm:text-[2.5rem] xl:text-[3.125rem] 2xl:text-[3.625rem]">
          {t('gov.heroTitle')}
        </h1>
        <span className="mt-4 block h-px w-16 bg-[var(--gov-gold)]" aria-hidden />
        <p className="mt-4 text-[0.9375rem] text-[var(--gov-hero-text-secondary)] xl:text-[1.0625rem]">
          {t('gov.heroPromise')}
        </p>
        <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-[var(--gov-gold)] px-3.5 py-2 text-[0.75rem] font-semibold tracking-[0.06em] text-[var(--gov-gold-text)]">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          {t('gov.restricted')}
        </p>
      </div>

      <div className="mt-10 lg:mt-0">
        <h2 className="sr-only">{t('gov.features')}</h2>
        <ul className="grid gap-3 sm:grid-cols-3 sm:gap-4 lg:max-w-[36rem]">
          <FeatureCard
            icon={<ShieldCheck className="h-5 w-5" aria-hidden />}
            title={t('gov.feature1Title')}
            body={t('gov.feature1Body')}
          />
          <FeatureCard
            icon={<FileCheck2 className="h-5 w-5" aria-hidden />}
            title={t('gov.feature2Title')}
            body={t('gov.feature2Body')}
          />
          <FeatureCard
            icon={<Languages className="h-5 w-5" aria-hidden />}
            title={t('gov.feature3Title')}
            body={t('gov.feature3Body')}
          />
        </ul>

        <p className="mt-6 flex items-center gap-2 text-[0.8125rem] text-[var(--gov-hero-text-secondary)]">
          <span
            aria-hidden
            className="flex h-5 w-5 items-center justify-center rounded-full border border-current opacity-70"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          </span>
          {t('gov.accountability')}
        </p>
      </div>
    </section>
  );
}

function FeatureCard({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li className="rounded-[0.625rem] border border-[var(--gov-feature-border)] bg-[var(--gov-feature-card)] p-4 backdrop-blur-[2px] transition-colors hover:border-[var(--gov-gold)]">
      <span className="flex h-9 w-9 items-center justify-center rounded-[0.5rem] text-[var(--gov-gold)]">
        {icon}
      </span>
      <h3 className="mt-2 text-[0.875rem] font-semibold text-[var(--gov-hero-text)]">{title}</h3>
      <p className="mt-1 text-[0.75rem] leading-snug text-[var(--gov-hero-text-secondary)]">
        {body}
      </p>
    </li>
  );
}
