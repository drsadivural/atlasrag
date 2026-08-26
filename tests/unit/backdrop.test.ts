import { describe, expect, it } from 'vitest';
import { BACKDROPS, timeOfDay } from '../../apps/web/src/lib/backdrop.js';

/**
 * Which desert stands behind the sign-in panel.
 *
 * The boundaries are the part worth pinning down: an off-by-one here shows somebody a
 * midnight sky at breakfast, and the text colours that ride along with it are what keep
 * the wordmark readable over either frame.
 */

const at = (hour: number, minute = 0) => new Date(2026, 7, 26, hour, minute);

describe('time of day', () => {
  it('treats 06:00 to 18:00 as daylight', () => {
    expect(timeOfDay(at(6))).toBe('day');
    expect(timeOfDay(at(12))).toBe('day');
    expect(timeOfDay(at(17, 59))).toBe('day');
  });

  it('treats the rest as night', () => {
    expect(timeOfDay(at(18))).toBe('night');
    expect(timeOfDay(at(23, 59))).toBe('night');
    expect(timeOfDay(at(0))).toBe('night');
    expect(timeOfDay(at(5, 59))).toBe('night');
  });
});

describe('backdrops', () => {
  it('pairs each time of day with its own photograph', () => {
    expect(BACKDROPS.day.image).not.toBe(BACKDROPS.night.image);
    expect(BACKDROPS.day.image).toMatch(/day/);
    expect(BACKDROPS.night.image).toMatch(/night/);
  });

  it('pins text colour to the photograph rather than leaving it to the theme', () => {
    // Dark ink over the day frame, light ink over the night one. Were either inherited
    // from the theme, the wrong combination would appear half the time.
    expect(luminance(BACKDROPS.day.text)).toBeLessThan(0.2);
    expect(luminance(BACKDROPS.night.text)).toBeGreaterThan(0.8);
  });

  it('keeps enough contrast between the two text weights to be a hierarchy', () => {
    for (const backdrop of Object.values(BACKDROPS)) {
      const gap = Math.abs(luminance(backdrop.text) - luminance(backdrop.textSecondary));
      expect(gap).toBeGreaterThan(0.05);
      expect(gap).toBeLessThan(0.5);
    }
  });
});

/** Rough relative luminance, enough to tell dark ink from light. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
