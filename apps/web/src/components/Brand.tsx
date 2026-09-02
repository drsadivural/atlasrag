import { cn } from '@uxe/ui';
import { useI18n } from '../lib/i18n.js';

/**
 * The UXE mark — the official logo, not a stand-in for it.
 *
 * Two files rather than one recoloured by CSS: the navy letterforms vanish on a dark
 * ground, and the orange chevron must not be lifted with them — it is the accent, and the
 * only part of the mark that stays exactly as drawn in both themes. Both are in the page
 * and a stylesheet rule shows one, because this also appears on the router's error page,
 * outside every provider, where nothing can be asked which theme is on.
 *
 * `size` is the height; the width follows the artwork's own proportions.
 */
export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  const width = Math.round(size * (LOGO_WIDTH / LOGO_HEIGHT));
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center', className)}
      style={{ width, height: size }}
    >
      <img
        src="/uxelogo.png"
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        alt=""
        decoding="async"
        draggable={false}
        className="uxe-logo-light h-full w-auto"
      />
      <img
        src="/uxelogo-dark.png"
        width={LOGO_WIDTH}
        height={LOGO_HEIGHT}
        alt=""
        decoding="async"
        draggable={false}
        className="uxe-logo-dark h-full w-auto"
      />
    </span>
  );
}

/** The artwork's pixel size, so the browser reserves the space before the file arrives. */
const LOGO_WIDTH = 488;
const LOGO_HEIGHT = 179;

/**
 * Wordmark: "UXE" in ink, "Consulting AI" in the brand gradient.
 *
 * Next to the logo the "UXE" is already said, in the artwork; `withMark` leaves it out so
 * the lockup does not read "UXE UXE Consulting AI".
 */
export function BrandWordmark({
  className,
  size = 'md',
  withMark = false,
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  withMark?: boolean;
}) {
  const scale = { sm: 'text-[17px]', md: 'text-[19px]', lg: 'text-[40px] sm:text-[52px]' }[size];
  return (
    <span className={cn('font-bold tracking-[-0.02em] text-[var(--uxe-text)]', scale, className)}>
      {!withMark && 'UXE '}
      <span className="gradient-text">Consulting AI</span>
    </span>
  );
}

export function BrandLockup({
  size = 'md',
  className,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const markSize = { sm: 28, md: 34, lg: 64 }[size];
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <BrandMark size={markSize} />
      <BrandWordmark size={size} withMark />
    </span>
  );
}

/**
 * Ayumi.
 *
 * `object-contain` keeps her full proportions at any container size, and the WebP variants
 * mean the login hero costs 180 KB rather than the 1.7 MB source PNG. When `decorative` is
 * set she is hidden from assistive technology — a second copy of the same person on one
 * screen should not be announced twice.
 */
export function Ayumi({
  variant = 'md',
  className,
  decorative = false,
  priority = false,
}: {
  variant?: 'sm' | 'md' | 'lg';
  className?: string;
  decorative?: boolean;
  priority?: boolean;
}) {
  const { t } = useI18n();
  const base =
    variant === 'lg'
      ? 'consultantgirl'
      : variant === 'md'
        ? 'consultantgirl-md'
        : 'consultantgirl-sm';
  const alt = decorative ? '' : t('app.consultantAlt');

  return (
    <picture>
      <source srcSet={`/${base}.webp`} type="image/webp" />
      <img
        src={`/${base}.png`}
        alt={alt}
        aria-hidden={decorative || undefined}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        className={cn('h-full w-full object-contain object-bottom select-none', className)}
        draggable={false}
      />
    </picture>
  );
}
