import { usePrefersReducedMotion } from '../../lib/preferences.js';
import { useTheme } from '../../lib/theme.js';

/**
 * The UXE mark.
 *
 * Two files rather than one recoloured by CSS: the navy letterforms vanish on the dark
 * header, and the orange chevron must not be lifted with them — it is the accent, and the
 * only part of the mark that stays exactly as drawn in both themes. The pair is swapped by
 * `<picture>` so the browser chooses before paint and neither flashes.
 */
export function GovernmentMark({ className }: { className?: string }) {
  const { resolved } = useTheme();

  return (
    <img
      src={resolved === 'dark' ? '/uxelogo-dark.png' : '/uxelogo.png'}
      width={488}
      height={179}
      alt=""
      aria-hidden
      decoding="async"
      className={className}
      draggable={false}
    />
  );
}

/**
 * The flowing decorative strokes behind the hero.
 *
 * Four ribbons in the page's restrained palette. Deliberately asymmetric and unequal in
 * weight so they read as decoration rather than as a flag: they are not arranged as
 * bands, not proportioned as one, and carry no emblem. Hidden from assistive technology,
 * and still when reduced motion is asked for.
 */
export function UnityLines({ className }: { className?: string }) {
  const reduced = usePrefersReducedMotion();

  return (
    <svg
      viewBox="0 0 620 260"
      className={className}
      aria-hidden
      focusable="false"
      preserveAspectRatio="xMaxYMid slice"
      fill="none"
    >
      {[
        { d: 'M0 210 C 190 210, 250 96, 620 96', stroke: 'var(--gov-gold)', width: 1.6, dash: 900 },
        {
          d: 'M0 226 C 200 226, 262 122, 620 122',
          stroke: 'var(--gov-red)',
          width: 1.2,
          dash: 940,
        },
        {
          d: 'M0 242 C 214 242, 276 148, 620 148',
          stroke: 'var(--gov-green)',
          width: 1.2,
          dash: 980,
        },
        {
          d: 'M0 258 C 228 258, 292 176, 620 176',
          stroke: 'var(--gov-graphite)',
          width: 1,
          dash: 1020,
        },
      ].map((line, index) => (
        <path
          key={line.d}
          d={line.d}
          stroke={line.stroke}
          strokeWidth={line.width}
          strokeLinecap="round"
          opacity={0.85 - index * 0.12}
          style={
            reduced
              ? undefined
              : {
                  strokeDasharray: line.dash,
                  strokeDashoffset: line.dash,
                  animation: `gov-draw 1400ms cubic-bezier(0.22, 1, 0.36, 1) ${index * 120}ms forwards`,
                }
          }
        />
      ))}
    </svg>
  );
}
