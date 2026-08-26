/**
 * The photograph behind the sign-in panel, chosen by the clock rather than by the theme.
 *
 * The app's light/dark setting says how somebody wants to read a screen; it says nothing
 * about whether the sun is up. These two frames are the same desert twelve hours apart,
 * so the one that matches the hour is the one that belongs behind the door.
 *
 * Ayumi stands in the right of both frames, which is why the panel needs no separate
 * illustration and why the scrim runs left to right: her side stays clear, and the words
 * sit on the empty dunes beside her.
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
   * Fills the panel above the photograph and is the colour the photograph fades into, so
   * the band has no hard edge. Sampled from the frame's own sky.
   */
  ground: string;
  /**
   * Laid over the top of the photograph only, carrying it into `ground`. The frame itself
   * is left alone: it is a composed picture, not a texture to print words on.
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
    ground: 'linear-gradient(180deg, #EAF2FC 0%, #D9E9FB 60%, #CFE3F8 100%)',
    scrim:
      'linear-gradient(180deg, #CFE3F8 0%, rgba(207,227,248,0.65) 22%, rgba(207,227,248,0) 52%)',
    text: '#0E1526',
    textSecondary: '#39435A',
  },
  night: {
    image: '/login-desert-night.webp',
    ground: 'linear-gradient(180deg, #070A12 0%, #0A0F1C 60%, #0C1220 100%)',
    scrim: 'linear-gradient(180deg, #0C1220 0%, rgba(12,18,32,0.65) 22%, rgba(12,18,32,0) 52%)',
    text: '#F4F6FB',
    textSecondary: '#BFC8D9',
  },
};
