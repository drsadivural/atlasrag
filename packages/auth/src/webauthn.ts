import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';

/**
 * WebAuthn / passkeys.
 *
 * The heavy lifting (CBOR parsing, attestation checks, signature verification) is left to
 * `@simplewebauthn/server` because hand-rolling it is a well-known source of bypasses.
 * What this module owns is binding the ceremony to *our* relying party, storing the
 * counter, and refusing a credential that was registered for a different origin.
 */

export interface WebAuthnConfig {
  /** The registrable domain, e.g. `uxe.example.com`. Never include a scheme or port. */
  rpId: string;
  rpName: string;
  /** Full origin(s) the browser will report, e.g. `https://uxe.example.com`. */
  expectedOrigins: string[];
}

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  signCount: number;
  transports: string[];
}

export async function buildRegistrationOptions(
  config: WebAuthnConfig,
  user: { id: string; email: string; fullName: string },
  existing: StoredCredential[],
) {
  return generateRegistrationOptions({
    rpID: config.rpId,
    rpName: config.rpName,
    userID: new TextEncoder().encode(user.id),
    userName: user.email,
    userDisplayName: user.fullName,
    attestationType: 'none',
    // Excluding registered credentials stops a user silently creating a duplicate passkey
    // on the same authenticator.
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });
}

export async function confirmRegistration(
  config: WebAuthnConfig,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
): Promise<StoredCredential> {
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpId,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error('Passkey registration could not be verified.');
  }

  const { credential } = verification.registrationInfo;
  return {
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    signCount: credential.counter,
    transports: response.response.transports ?? [],
  };
}

export async function buildAuthenticationOptions(
  config: WebAuthnConfig,
  credentials: StoredCredential[],
) {
  return generateAuthenticationOptions({
    rpID: config.rpId,
    allowCredentials: credentials.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    userVerification: 'preferred',
  });
}

export interface AuthenticationOutcome {
  verified: boolean;
  newSignCount: number;
  /**
   * True when the authenticator's counter did not advance. That is the classic signal of a
   * cloned credential, so the caller must treat it as a failure and alert the user rather
   * than silently accepting the sign-in.
   */
  possibleClone: boolean;
}

export async function confirmAuthentication(
  config: WebAuthnConfig,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
  credential: StoredCredential,
): Promise<AuthenticationOutcome> {
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpId,
    credential: {
      id: credential.credentialId,
      publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
      counter: credential.signCount,
      transports: credential.transports as never,
    },
    requireUserVerification: false,
  });

  const newSignCount = verification.authenticationInfo?.newCounter ?? credential.signCount;
  // Authenticators that always report 0 are permitted by the spec; only a stalled non-zero
  // counter indicates cloning.
  const possibleClone =
    credential.signCount > 0 && newSignCount <= credential.signCount && verification.verified;

  return {
    verified: verification.verified && !possibleClone,
    newSignCount,
    possibleClone,
  };
}
