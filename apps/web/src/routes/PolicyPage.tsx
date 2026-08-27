import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../lib/i18n.js';
import { GovernmentMark } from './government/Decoration.js';

type Policy = 'privacy' | 'security' | 'accessibility' | 'support';

/**
 * The pages the sign-in footer links to.
 *
 * Real routes with real content rather than placeholders: a footer link that opens
 * nothing is a broken promise on a page whose whole subject is trust. Each states what
 * this deployment actually does, and says plainly where a claim depends on how it has
 * been configured rather than asserting a certification nobody has verified.
 */
export function PolicyPage({ policy }: { policy: Policy }) {
  const { t } = useI18n();
  const content = CONTENT[policy];

  return (
    <div data-surface="government" className="min-h-dvh bg-[var(--gov-page)]">
      <header className="flex h-[4.75rem] items-center gap-3 border-b border-[var(--gov-header-border)] bg-[var(--gov-header)] px-4 sm:px-8 lg:px-[3.75rem]">
        <GovernmentMark className="h-7 w-auto select-none" />
        <span className="text-[1.0625rem] font-bold text-[var(--gov-header-text)]">
          {t('gov.brand')}
        </span>
      </header>

      <main id="main" className="mx-auto w-full max-w-[46rem] px-4 py-10 sm:px-8">
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 rounded-[0.375rem] text-[0.8125rem] font-medium text-[var(--gov-text-secondary)] underline-offset-2 hover:text-[var(--gov-text)] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--gov-focus)]"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" aria-hidden />
          {t('gov.signInTitle')}
        </Link>

        <h1 className="mt-5 text-[1.875rem] font-bold text-[var(--gov-text)]">{content.title}</h1>
        <p className="mt-2 text-[0.9375rem] text-[var(--gov-text-secondary)]">{content.summary}</p>

        <div className="mt-8 flex flex-col gap-6">
          {content.sections.map((section) => (
            <section key={section.heading}>
              <h2 className="text-[1.0625rem] font-semibold text-[var(--gov-text)]">
                {section.heading}
              </h2>
              <ul className="mt-2 flex flex-col gap-1.5">
                {section.points.map((point) => (
                  <li
                    key={point}
                    className="text-[0.875rem] leading-relaxed text-[var(--gov-text-secondary)]"
                  >
                    {point}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

const CONTENT: Record<
  Policy,
  { title: string; summary: string; sections: Array<{ heading: string; points: string[] }> }
> = {
  privacy: {
    title: 'Privacy notice',
    summary:
      'What this service records when you sign in, why it records it, and how long it keeps it.',
    sections: [
      {
        heading: 'What is recorded at sign-in',
        points: [
          'Your email address, the time, the outcome, your IP address and your browser user agent.',
          'Passwords are never recorded. Neither are identity-provider tokens.',
          'A refused sign-in records the reason and the address domain, not the address itself.',
        ],
      },
      {
        heading: 'Why',
        points: [
          'To let your entity administrator see who reached the workspace and when.',
          'To detect and slow down credential-guessing against your account.',
        ],
      },
      {
        heading: 'How long',
        points: [
          'Authentication events follow the retention policy your entity administrator sets.',
          'Sessions end at the idle and absolute timeouts configured for your workspace.',
        ],
      },
    ],
  },
  security: {
    title: 'Security',
    summary: 'The controls this sign-in screen and the session behind it actually apply.',
    sections: [
      {
        heading: 'Sign-in',
        points: [
          'UAE PASS and Government SSO use OpenID Connect authorization code with PKCE, and state and nonce are validated server-side.',
          'Neither flow can create an account. An identity that is not already provisioned is refused.',
          'Passwords are hashed with PBKDF2-HMAC-SHA512 at 600,000 iterations.',
          'An invalid password and an unknown address produce the same response, so this screen cannot be used to discover who has an account.',
        ],
      },
      {
        heading: 'Sessions',
        points: [
          'Session cookies are HttpOnly, SameSite and Secure over HTTPS, and are rotated after authentication.',
          'State-changing requests carry a CSRF token bound to the session.',
          '“Remember this device” extends the session to at most 30 days and can be revoked by you or an administrator at any time.',
        ],
      },
      {
        heading: 'What is not claimed here',
        points: [
          'Data residency is stated on the sign-in screen only when this deployment has been configured to assert it.',
          'No certification is claimed on this page. Ask your entity administrator for the compliance position of your deployment.',
        ],
      },
    ],
  },
  accessibility: {
    title: 'Accessibility',
    summary:
      'This service targets WCAG 2.2 AA. What that means here, and what to do if it falls short.',
    sections: [
      {
        heading: 'On this screen',
        points: [
          'Every control is reachable and operable by keyboard, with a visible focus indicator.',
          'Text size, high contrast, reduced motion and theme can be set from the accessibility button in the header, without an account.',
          'The page is usable at 200% and 400% zoom without loss of content or function.',
          'Arabic renders as a true right-to-left layout rather than translated text in a left-to-right frame.',
        ],
      },
      {
        heading: 'If something does not work',
        points: [
          'Report it through Contact support. Include the page, what you were using and what happened.',
        ],
      },
    ],
  },
  support: {
    title: 'Contact support',
    summary: 'Who to ask, and in what order.',
    sections: [
      {
        heading: 'Your entity administrator first',
        points: [
          'Access to this service is provisioned by your entity. An administrator there can create, suspend and restore your access.',
          'They can also reset multi-factor enrolment and revoke a session on a lost device.',
        ],
      },
      {
        heading: 'This service',
        points: [
          'For a fault in the service itself rather than in your access, report it through the channel your entity has been given.',
          'Never include a password or a one-time code in a support message.',
        ],
      },
    ],
  },
};
