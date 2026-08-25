import { cn } from '@uxe/ui';
import { useI18n } from '../lib/i18n.js';

/** The product mark: a gradient tile with the sparkle glyph, matching the concepts. */
export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[calc(var(--uxe-radius-card)-2px)]',
        'gradient-surface shadow-[var(--uxe-shadow-brand)]',
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
        <path
          d="M12 2.5l1.9 5.3 5.3 1.9-5.3 1.9L12 16.9l-1.9-5.3L4.8 9.7l5.3-1.9L12 2.5z"
          fill="white"
        />
        <circle cx="18.6" cy="17.6" r="2.1" fill="white" fillOpacity="0.92" />
        <circle cx="6.2" cy="18.4" r="1.3" fill="white" fillOpacity="0.7" />
      </svg>
    </span>
  );
}

/** Wordmark: "UXE" in ink, "Consulting AI" in the brand gradient. */
export function BrandWordmark({
  className,
  size = 'md',
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}) {
  const scale = { sm: 'text-[17px]', md: 'text-[19px]', lg: 'text-[40px] sm:text-[52px]' }[size];
  return (
    <span className={cn('font-bold tracking-[-0.02em] text-[var(--uxe-text)]', scale, className)}>
      UXE <span className="gradient-text">Consulting AI</span>
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
  const markSize = { sm: 32, md: 40, lg: 76 }[size];
  return (
    <span className={cn('inline-flex items-center gap-3', className)}>
      <BrandMark size={markSize} />
      <BrandWordmark size={size} />
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
