import { api } from '../../lib/api.js';

/**
 * What the sign-in screen is allowed to know about this deployment.
 *
 * Availability only — never a client id, an endpoint or a secret. The screen has to be
 * able to say honestly whether a button will work, and nothing beyond that reaches the
 * browser.
 */
export interface GovernmentConfig {
  uaePass: { available: boolean; environment: string; requiredEnv: string[] };
  sso: { available: boolean; requiredEnv: string[] };
  dataResidency: boolean;
  /** Whether this deployment offers a route to a new account from the sign-in screen. */
  publicRegistration: boolean;
  allowedDomains: string[];
  postLoginRoute?: string;
  links: {
    privacy: string;
    security: string;
    accessibility: string;
    support: string;
    status: string;
    incident: string;
    uaePassHelp: string;
    ssoHelp: string;
  };
}

export function fetchGovernmentConfig(): Promise<GovernmentConfig> {
  return api.get<GovernmentConfig>('/auth/government/config');
}
