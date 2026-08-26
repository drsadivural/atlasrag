import { usePrefersReducedMotion } from '../../lib/preferences.js';

/**
 * The geometric UXE mark.
 *
 * An eight-pointed interlaced figure drawn as strokes rather than an imported bitmap, so
 * it stays crisp at any size and takes its colour from the surrounding theme. It is the
 * product's own mark: no emblem, seal or coat of arms is used or implied anywhere on this
 * page.
 */
export function GovernmentMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      role="img"
      aria-hidden
      focusable="false"
      fill="none"
    >
      <path
        d="M20 2.5 30.5 7.5 35.5 18 30.5 28.5 20 33.5 9.5 28.5 4.5 18 9.5 7.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M20 8 27 11.5 30.5 18.5 27 25.5 20 29 13 25.5 9.5 18.5 13 11.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        opacity="0.75"
      />
      <path d="M20 13.5 23.2 20 20 26.5 16.8 20Z" fill="currentColor" opacity="0.9" />
    </svg>
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
