import type { Role } from '@uxe/contracts';
import { rankOfRole } from '@uxe/contracts';

export type MfaPolicy = 'optional' | 'required_admins' | 'required_all';

/**
 * Whether this user must clear an MFA challenge before the session becomes usable.
 *
 * A user who has voluntarily enrolled a factor is always challenged, even under the
 * `optional` policy — otherwise enrolling would weaken nothing but also protect nothing.
 */
export function requiresMfa(input: {
  policy: MfaPolicy;
  role: Role;
  hasActiveFactor: boolean;
}): boolean {
  if (input.hasActiveFactor) return true;
  if (input.policy === 'required_all') return true;
  // Admin and Owner sit above Consultant in the role ranking.
  if (input.policy === 'required_admins') return rankOfRole(input.role) <= rankOfRole('admin');
  return false;
}

/**
 * A user under a policy that requires MFA but who has not enrolled must be routed into
 * enrolment rather than being let in or locked out.
 */
export function mustEnrollMfa(input: {
  policy: MfaPolicy;
  role: Role;
  hasActiveFactor: boolean;
}): boolean {
  if (input.hasActiveFactor) return false;
  if (input.policy === 'required_all') return true;
  if (input.policy === 'required_admins') return rankOfRole(input.role) <= rankOfRole('admin');
  return false;
}

export interface SessionLifetime {
  idleMinutes: number;
  absoluteHours: number;
}

/**
 * "Remember me" extends the idle window, never the absolute one. The absolute cap is what
 * guarantees that a stolen session eventually dies even if the thief keeps it warm.
 */
export function sessionLifetime(input: {
  rememberMe: boolean;
  policyIdleMinutes: number;
  policyAbsoluteHours: number;
}): SessionLifetime {
  return {
    idleMinutes: input.rememberMe
      ? Math.max(input.policyIdleMinutes, 60 * 24 * 14)
      : input.policyIdleMinutes,
    absoluteHours: input.policyAbsoluteHours,
  };
}

export interface LockoutState {
  locked: boolean;
  retryAfterSeconds: number | null;
  message: string | null;
}

export function evaluateLockout(
  user: {
    failedLoginCount: number;
    lockedUntil: Date | null;
  },
  now = new Date(),
): LockoutState {
  if (user.lockedUntil && user.lockedUntil > now) {
    const retryAfterSeconds = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 1000);
    return {
      locked: true,
      retryAfterSeconds,
      message: `Too many failed sign-in attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s), or reset your password.`,
    };
  }
  return { locked: false, retryAfterSeconds: null, message: null };
}

/**
 * A short list of the passwords that dominate every credential-stuffing corpus, plus
 * product-specific terms. A full breach-list check belongs behind a network call; this
 * catches the cases that would otherwise be trivially guessable on day one.
 */
const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '123456',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwerty123',
  'letmein',
  'welcome',
  'welcome1',
  'admin',
  'admin123',
  'iloveyou',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'abc123',
  'changeme',
  'trustno1',
  'uxeconsulting',
  'consulting',
  'uxeconsultingai',
]);

export interface PasswordCheck {
  ok: boolean;
  reasons: string[];
}

export function checkPasswordStrength(
  password: string,
  context: { email?: string; fullName?: string; workspaceName?: string } = {},
): PasswordCheck {
  const reasons: string[] = [];
  const lower = password.toLowerCase();

  if (password.length < 12) reasons.push('Use at least 12 characters.');
  if (!/[a-z]/.test(password)) reasons.push('Add a lowercase letter.');
  if (!/[A-Z]/.test(password)) reasons.push('Add an uppercase letter.');
  if (!/\d/.test(password)) reasons.push('Add a number.');
  if (WEAK_PASSWORDS.has(lower.replace(/[^a-z0-9]/g, ''))) {
    reasons.push('This password appears on common breach lists.');
  }

  // Personal information makes a password guessable regardless of its character classes.
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) {
    reasons.push('Do not use your email address in your password.');
  }
  for (const word of (context.fullName ?? '').toLowerCase().split(/\s+/)) {
    if (word.length >= 4 && lower.includes(word)) {
      reasons.push('Do not use your name in your password.');
      break;
    }
  }
  if (
    context.workspaceName &&
    context.workspaceName.length >= 4 &&
    lower.includes(context.workspaceName.toLowerCase())
  ) {
    reasons.push('Do not use your workspace name in your password.');
  }

  // Runs like "aaaa" or "1234" defeat length requirements without adding entropy.
  if (/(.)\1{3,}/.test(password))
    reasons.push('Avoid repeating the same character four or more times.');
  if (/(?:0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef|qwer|asdf)/i.test(password)) {
    reasons.push('Avoid sequential characters.');
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}
