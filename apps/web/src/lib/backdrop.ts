/**
 * The photograph behind the sign-in panel, chosen by the clock rather than by the theme.
 *
 * The app's light/dark setting says how somebody wants to read a screen; it says nothing
 * about whether the sun is up. These two frames are the same desert twelve hours apart,
 * so the one that matches the hour is the one that belongs behind the door.
 */

export type TimeOfDay = 'day' | 'night';

/** Daylight runs 06:00 to 18:00 on the viewer's own clock. */
export function timeOfDay(at: Date = new Date()): TimeOfDay {
  const hour = at.getHours();
  return hour >= 6 && hour < 18 ? 'day' : 'night';
}

export interface Backdrop {
  image: string;
  /**
   * Laid over the photograph. Heaviest at the top, where the wordmark and the promise
   * sit, and thinnest at the bottom, where nothing but sand is behind Ayumi.
   */
  scrim: string;
  /**
   * Pinned to the photograph, not inherited from the theme: dark text over the night
   * frame, or light text over the day frame, would be unreadable whichever theme the
   * viewer happens to be using.
   */
  text: string;
  textSecondary: string;
}

export const BACKDROPS: Record<TimeOfDay, Backdrop> = {
  day: {
    image: '/login-desert-day.webp',
    scrim:
      'linear-gradient(168deg, rgba(255,255,255,0.94) 0%, rgba(250,251,255,0.86) 34%, rgba(247,249,255,0.62) 62%, rgba(255,252,246,0.34) 100%)',
    text: '#101627',
    textSecondary: '#3B4459',
  },
  night: {
    image: '/login-desert-night.webp',
    scrim:
      'linear-gradient(168deg, rgba(8,11,20,0.92) 0%, rgba(10,14,26,0.84) 34%, rgba(12,17,32,0.62) 62%, rgba(14,20,38,0.36) 100%)',
    text: '#F4F6FB',
    textSecondary: '#BFC8D9',
  },
};
