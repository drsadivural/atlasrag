import { describe, expect, it } from 'vitest';
import {
  buildUaePassAuthorization,
  exchangeUaePassCode,
  fetchUaePassProfile,
  isAllowedGovernmentEmail,
  readIdTokenClaims,
  UaePassError,
} from '../../apps/api/src/services/uae-pass.js';
import {
  allowedGovernmentDomains,
  allowedSsoTenants,
  uaePassConfig,
} from '../../apps/api/src/env.js';
import type { AppEnv } from '../../apps/api/src/env.js';

/**
 * UAE PASS.
 *
 * No request here reaches the provider: this deployment has no registered application,
 * and the tests would be worthless if they did. What is checked is everything this
 * codebase decides — that a half-configured provider counts as absent, that the
 * authorization request carries PKCE and the values it must, and that a refusal is a
 * refusal rather than a session.
 */

const FULL: Partial<AppEnv> = {
  UAE_PASS_ISSUER: 'https://stg-id.uaepass.ae',
  UAE_PASS_AUTHORIZATION_ENDPOINT: 'https://stg-id.uaepass.ae/idshub/authorize',
  UAE_PASS_TOKEN_ENDPOINT: 'https://stg-id.uaepass.ae/idshub/token',
  UAE_PASS_USERINFO_ENDPOINT: 'https://stg-id.uaepass.ae/idshub/userinfo',
  UAE_PASS_CLIENT_ID: 'client-id',
  UAE_PASS_CLIENT_SECRET: 'client-secret',
  UAE_PASS_SCOPES: 'openid profile email',
  UAE_PASS_ACR_VALUES: 'urn:safelayer:tws:policies:authentication:level:low',
  UAE_PASS_ENVIRONMENT: 'staging',
};

const env = (over: Partial<AppEnv> = {}) => ({ ...FULL, ...over }) as AppEnv;

describe('provider configuration', () => {
  it('treats a half-configured provider as absent', () => {
    expect(uaePassConfig(env())).not.toBeNull();
    // Any one missing piece makes the whole thing unusable, and an enabled button that
    // fails at the redirect is worse for the person pressing it than a disabled one.
    for (const key of [
      'UAE_PASS_ISSUER',
      'UAE_PASS_AUTHORIZATION_ENDPOINT',
      'UAE_PASS_TOKEN_ENDPOINT',
      'UAE_PASS_USERINFO_ENDPOINT',
      'UAE_PASS_CLIENT_ID',
      'UAE_PASS_CLIENT_SECRET',
    ] as const) {
      expect(uaePassConfig(env({ [key]: '' })), key).toBeNull();
    }
  });

  it('fails closed on the tenant allowlist', () => {
    // Empty means no tenant is accepted, not that every tenant is.
    expect(allowedSsoTenants(env({ GOV_SSO_ALLOWED_TENANTS: '' }))).toEqual([]);
    expect(allowedSsoTenants(env({ GOV_SSO_ALLOWED_TENANTS: 'a, b ,' }))).toEqual(['a', 'b']);
  });

  it('reads the domain allowlist without empty entries', () => {
    expect(
      allowedGovernmentDomains(env({ GOV_ALLOWED_EMAIL_DOMAINS: 'gov.ae, Abu.gov.ae ,' })),
    ).toEqual(['gov.ae', 'abu.gov.ae']);
  });
});

describe('the authorization request', () => {
  it('carries PKCE, a nonce and the configured ACR, and never the secret', async () => {
    const config = uaePassConfig(env())!;
    const request = await buildUaePassAuthorization(config, 'https://app.example/callback');
    const url = new URL(request.url);

    expect(url.origin + url.pathname).toBe(config.authorizationEndpoint);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('acr_values')).toBe(config.acrValues);
    expect(url.searchParams.get('state')).toBe(request.state);
    expect(url.searchParams.get('nonce')).toBe(request.nonce);

    // The verifier stays on the server; only its hash goes to the provider.
    expect(request.url).not.toContain(request.codeVerifier);
    expect(request.url).not.toContain(config.clientSecret);
  });

  it('produces a different state and verifier every time', async () => {
    const config = uaePassConfig(env())!;
    const a = await buildUaePassAuthorization(config, 'https://app.example/callback');
    const b = await buildUaePassAuthorization(config, 'https://app.example/callback');
    expect(a.state).not.toBe(b.state);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('the token exchange', () => {
  it('sends the code and verifier, and authenticates the client in the header', async () => {
    const config = uaePassConfig(env())!;
    let seen: { url: string; init?: RequestInit } | null = null;

    await exchangeUaePassCode(
      config,
      'https://app.example/callback',
      'the-code',
      'the-verifier',
      async (url, init) => {
        seen = { url, ...(init ? { init } : {}) };
        return new Response(JSON.stringify({ access_token: 'at', id_token: 'it' }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    expect(seen!.url).toBe(config.tokenEndpoint);
    const headers = seen!.init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Basic /);
    const body = new URLSearchParams(String(seen!.init?.body));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('code_verifier')).toBe('the-verifier');
  });

  it("does not carry the provider's own message back to the browser", async () => {
    const config = uaePassConfig(env())!;
    await expect(
      exchangeUaePassCode(
        config,
        'https://app.example/callback',
        'code',
        'verifier',
        async () =>
          new Response(JSON.stringify({ error_description: 'user 784-1990-1234567-1 blocked' }), {
            status: 400,
          }),
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof UaePassError && !/784-1990/.test((error as Error).message),
    );
  });
});

describe('the profile', () => {
  it('reads a subject and normalises the address', async () => {
    const config = uaePassConfig(env())!;
    const profile = await fetchUaePassProfile(
      config,
      'access-token',
      async () =>
        new Response(
          JSON.stringify({
            sub: 'subject-1',
            email: '  Person@Entity.GOV.AE ',
            firstnameEN: 'Aisha',
            lastnameEN: 'Al Marri',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );

    expect(profile.subject).toBe('subject-1');
    expect(profile.email).toBe('person@entity.gov.ae');
    expect(profile.fullName).toBe('Aisha Al Marri');
  });

  it('refuses an identity with no subject rather than inventing one', async () => {
    const config = uaePassConfig(env())!;
    await expect(
      fetchUaePassProfile(
        config,
        'access-token',
        async () => new Response(JSON.stringify({ email: 'a@gov.ae' }), { status: 200 }),
      ),
    ).rejects.toBeInstanceOf(UaePassError);
  });
});

describe('claims and allowlists', () => {
  it('reads id token claims without treating them as proof', () => {
    const payload = btoa(JSON.stringify({ nonce: 'n1', iss: 'https://issuer', aud: 'client-id' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(readIdTokenClaims(`header.${payload}.signature`)).toMatchObject({ nonce: 'n1' });
    // A malformed token is empty claims, not a thrown error, because the caller checks
    // what it needs and the userinfo endpoint is what actually establishes identity.
    expect(readIdTokenClaims('not-a-token')).toEqual({});
  });

  it('accepts an entity subdomain but not a lookalike', () => {
    expect(isAllowedGovernmentEmail('a@gov.ae', ['gov.ae'])).toBe(true);
    expect(isAllowedGovernmentEmail('a@entity.gov.ae', ['gov.ae'])).toBe(true);
    expect(isAllowedGovernmentEmail('a@notgov.ae', ['gov.ae'])).toBe(false);
    expect(isAllowedGovernmentEmail('a@gov.ae.example.com', ['gov.ae'])).toBe(false);
    // An empty list is the check switched off, which a development instance needs.
    expect(isAllowedGovernmentEmail('a@anything.test', [])).toBe(true);
  });
});
