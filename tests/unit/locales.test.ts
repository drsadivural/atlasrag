import { describe, expect, it } from 'vitest';
import { en } from '../../apps/web/src/lib/locales/en.js';
import { ar } from '../../apps/web/src/lib/locales/ar.js';
import { ja } from '../../apps/web/src/lib/locales/ja.js';

/**
 * What a locale has to cover before it can be offered.
 *
 * Arabic is offered as a workspace language, so choosing it has to change the whole
 * application rather than the sign-in screen and nothing else. English falling in behind a
 * missing key is the right runtime behaviour and the wrong thing to ship: nobody sees an
 * error, they just read half a product in a language they did not choose.
 *
 * Japanese is deliberately not held to this. It is not offered as a complete locale, and
 * the point of these tests is to keep that difference honest rather than to freeze it.
 */

const keys = Object.keys(en) as Array<keyof typeof en>;
const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();

describe('Arabic', () => {
  it('translates every key English defines', () => {
    const missing = keys.filter((key) => !(key in ar));
    expect(missing, `untranslated: ${missing.join(', ')}`).toEqual([]);
  });

  it('leaves no key in English by accident', () => {
    /*
     * Some values are correct in both: a product name, a provider's name, an address
     * placeholder. Everything else matching English exactly means the key was copied and
     * never translated, which is invisible at runtime because the fallback produces the
     * same string.
     */
    const shared = new Set([
      'app.name',
      'auth.emailPlaceholder',
      'auth.continueGoogle',
      'auth.continueMicrosoft',
      'knowledge.googleDrive',
      'knowledge.oneDrive',
      'knowledge.sharePoint',
      'gov.brand',
      'gov.english',
      // Each language names itself in its own script on the switcher.
      'gov.arabic',
      'gov.emailPlaceholder',
      'consult.sendHint',
    ]);
    const untranslated = keys.filter(
      (key) => !shared.has(key) && ar[key] !== undefined && ar[key] === en[key],
    );
    expect(untranslated, `identical to English: ${untranslated.join(', ')}`).toEqual([]);
  });

  it('carries every interpolation marker across', () => {
    // A translated {name} renders the literal braces, and the person's name never appears.
    const broken = keys
      .filter((key) => ar[key] !== undefined)
      .filter((key) => placeholders(en[key]).join() !== placeholders(ar[key] as string).join());
    expect(broken, `placeholders differ: ${broken.join(', ')}`).toEqual([]);
  });
});

describe('Japanese', () => {
  it('carries every interpolation marker across the keys it does translate', () => {
    const broken = keys
      .filter((key) => ja[key] !== undefined)
      .filter((key) => placeholders(en[key]).join() !== placeholders(ja[key] as string).join());
    expect(broken, `placeholders differ: ${broken.join(', ')}`).toEqual([]);
  });
});
