import type { AnswerStyle, TaskMode, WorkspaceSettings } from '@uxe/contracts';
import type { MfaPolicy } from '@uxe/auth';

/**
 * Workspace settings live in a JSONB column so a new preference does not require a
 * migration, but they are read back through this normaliser so every consumer sees a
 * complete, typed object even when the stored blob predates a field.
 */
export function defaultWorkspaceSettings(
  ownerName: string,
  locale: string,
): Record<string, unknown> {
  return {
    consultant: {
      name: 'Ayumi',
      title: 'Compliance Consultant',
      avatarUrl: '/assets/consultantgirl.png',
      greeting: `Ask Ayumi anything grounded in your approved sources.`,
      behaviorNotes: `Answer only from approved sources. State uncertainty plainly. Always cite exact clause and page.`,
      defaultAnswerStyle: 'optimal',
      defaultTaskMode: 'ask',
    },
    answers: {
      knowledgeOnly: true,
      askWhenUncertain: true,
      // Disabled by default, per the product rule that nothing outside the knowledge base
      // is asserted unless a workspace explicitly opts in.
      generalModelFallback: false,
      requireCitations: true,
      minimumEvidenceThreshold: 0.3,
      minimumCitationsPerClaim: 1,
    },
    security: {
      mfaPolicy: 'optional',
      sessionIdleMinutes: 480,
      sessionAbsoluteHours: 720,
      allowedEmailDomains: [],
      ssoEnforced: false,
    },
    retention: {
      consultationDays: 365,
      artifactDays: 365,
      auditDays: 730,
      purgeGraceDays: 30,
      legalHold: false,
    },
    notifications: { jobCompletion: true, weeklyDigest: false, criticalFindings: true },
    locale,
    ownerName,
  };
}

interface RawSettings {
  consultant?: Partial<WorkspaceSettings['consultant']>;
  answers?: Partial<WorkspaceSettings['answers']>;
  security?: Partial<WorkspaceSettings['security']> & { mfaPolicy?: string };
  retention?: Partial<WorkspaceSettings['retention']>;
  notifications?: Partial<WorkspaceSettings['notifications']>;
}

/**
 * Gulf Standard Time.
 *
 * The entities this is built for are in the UAE, and a workspace that silently formats
 * every report and audit line in UTC is four hours wrong on every date somebody checks.
 */
export const DEFAULT_TIMEZONE = 'Asia/Dubai';

export function workspaceSettingsFrom(
  stored: Record<string, unknown>,
  workspaceName: string,
  overrides: Partial<{
    slug: string;
    locale: string;
    timezone: string;
    brandColor: string;
    logoUrl: string | null;
  }> = {},
): WorkspaceSettings {
  const raw = stored as RawSettings;
  const defaults = defaultWorkspaceSettings('', overrides.locale ?? 'en') as unknown as RawSettings;

  return {
    general: {
      workspaceName,
      slug: overrides.slug ?? 'main',
      locale: (overrides.locale ?? 'en') as WorkspaceSettings['general']['locale'],
      timezone: overrides.timezone ?? DEFAULT_TIMEZONE,
      brandColor: overrides.brandColor ?? '#3156F5',
      logoUrl: overrides.logoUrl ?? null,
    },
    consultant: {
      name: raw.consultant?.name ?? defaults.consultant?.name ?? 'Ayumi',
      title: raw.consultant?.title ?? defaults.consultant?.title ?? 'Compliance Consultant',
      avatarUrl: raw.consultant?.avatarUrl ?? '/assets/consultantgirl.png',
      greeting: raw.consultant?.greeting ?? defaults.consultant?.greeting ?? '',
      behaviorNotes: raw.consultant?.behaviorNotes ?? defaults.consultant?.behaviorNotes ?? '',
      defaultAnswerStyle: (raw.consultant?.defaultAnswerStyle ?? 'optimal') as AnswerStyle,
      defaultTaskMode: (raw.consultant?.defaultTaskMode ?? 'ask') as TaskMode,
    },
    answers: {
      knowledgeOnly: raw.answers?.knowledgeOnly ?? true,
      askWhenUncertain: raw.answers?.askWhenUncertain ?? true,
      generalModelFallback: raw.answers?.generalModelFallback ?? false,
      requireCitations: raw.answers?.requireCitations ?? true,
      minimumEvidenceThreshold: clamp01(raw.answers?.minimumEvidenceThreshold ?? 0.3),
      minimumCitationsPerClaim: raw.answers?.minimumCitationsPerClaim ?? 1,
    },
    security: {
      mfaPolicy: normalizeMfaPolicy(raw.security?.mfaPolicy),
      sessionIdleMinutes: raw.security?.sessionIdleMinutes ?? 480,
      sessionAbsoluteHours: raw.security?.sessionAbsoluteHours ?? 720,
      allowedEmailDomains: raw.security?.allowedEmailDomains ?? [],
      ssoEnforced: raw.security?.ssoEnforced ?? false,
    },
    retention: {
      consultationDays: raw.retention?.consultationDays ?? 365,
      artifactDays: raw.retention?.artifactDays ?? 365,
      auditDays: raw.retention?.auditDays ?? 730,
      purgeGraceDays: raw.retention?.purgeGraceDays ?? 30,
      legalHold: raw.retention?.legalHold ?? false,
    },
    notifications: {
      jobCompletion: raw.notifications?.jobCompletion ?? true,
      weeklyDigest: raw.notifications?.weeklyDigest ?? false,
      criticalFindings: raw.notifications?.criticalFindings ?? true,
    },
  };
}

/** Deep-merges a partial update onto the stored blob without dropping unknown keys. */
export function mergeSettings(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = mergeSettings(
        (stored[key] as Record<string, unknown> | undefined) ?? {},
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}

function normalizeMfaPolicy(value: string | undefined): MfaPolicy {
  return value === 'required_all' || value === 'required_admins' ? value : 'optional';
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.3;
  return Math.max(0, Math.min(1, value));
}
