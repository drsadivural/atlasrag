import type { Role } from './primitives.js';
import { ROLE_ORDER } from './primitives.js';

/**
 * Every capability the server checks. The web app uses the same list to decide what to
 * render, but rendering is a courtesy — the authoritative check always runs server-side
 * in the repository layer.
 */
export const PERMISSIONS = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'member:read',
  'member:invite',
  'member:update',
  'member:suspend',
  'member:remove',
  'group:manage',
  'source:read',
  'source:create',
  'source:update',
  'source:reprocess',
  'source:archive',
  'source:delete',
  'source:permissions',
  'source:promote',
  'consultation:read',
  'consultation:read_all',
  'consultation:create',
  'consultation:update',
  'consultation:delete',
  'consultation:share',
  'review:create',
  'review:approve',
  'report:create',
  'artifact:read',
  'artifact:download',
  'artifact:delete',
  'correction:create',
  'correction:decide',
  'correction:generate',
  'audit:read',
  'audit:export',
  'settings:read',
  'settings:update',
  'settings:security',
  'settings:models',
  'settings:retention',
  'retention:purge',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = [
  'workspace:read',
  'member:read',
  'source:read',
  'consultation:read',
  'artifact:read',
  'settings:read',
];

const MEMBER: Permission[] = [
  ...READ_ONLY,
  'consultation:create',
  'consultation:update',
  'consultation:delete',
  'artifact:download',
  'report:create',
];

/** Reviewers can approve findings and read every consultation, but cannot author sources. */
const REVIEWER: Permission[] = [
  ...MEMBER,
  'consultation:read_all',
  'review:approve',
  'correction:decide',
  'audit:read',
];

/** Knowledge Managers own the knowledge base but do not run reviews or corrections. */
const KNOWLEDGE_MANAGER: Permission[] = [
  ...MEMBER,
  'source:create',
  'source:update',
  'source:reprocess',
  'source:archive',
  'source:delete',
  'source:permissions',
  'source:promote',
];

/** Consultants do the client-facing work end to end. */
const CONSULTANT: Permission[] = [
  ...MEMBER,
  'source:create',
  'source:update',
  'source:reprocess',
  'source:promote',
  'consultation:share',
  'review:create',
  'correction:create',
  'correction:decide',
  'correction:generate',
];

const ADMIN: Permission[] = [
  ...new Set<Permission>([
    ...CONSULTANT,
    ...KNOWLEDGE_MANAGER,
    ...REVIEWER,
    'workspace:update',
    'member:invite',
    'member:update',
    'member:suspend',
    'member:remove',
    'group:manage',
    'source:delete',
    'source:permissions',
    'artifact:delete',
    'audit:read',
    'audit:export',
    'settings:update',
    'settings:security',
    'settings:models',
    'settings:retention',
  ]),
];

const OWNER: Permission[] = [
  ...new Set<Permission>([...ADMIN, 'workspace:delete', 'retention:purge']),
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: OWNER,
  admin: ADMIN,
  consultant: CONSULTANT,
  knowledge_manager: KNOWLEDGE_MANAGER,
  reviewer: REVIEWER,
  member: MEMBER,
  read_only: READ_ONLY,
};

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Lower rank number means more privileged. Used to stop privilege escalation. */
export function rankOfRole(role: Role): number {
  return ROLE_ORDER.indexOf(role);
}

/**
 * An actor may only assign a role at or below their own rank, and may never change
 * the role of somebody more privileged than themselves. This is what stops an Admin
 * from promoting themselves to Owner or demoting the Owner.
 */
export function canAssignRole(actor: Role, targetCurrent: Role, targetNext: Role): boolean {
  if (!roleHasPermission(actor, 'member:update')) return false;
  const actorRank = rankOfRole(actor);
  if (rankOfRole(targetCurrent) < actorRank) return false;
  if (rankOfRole(targetNext) < actorRank) return false;
  return true;
}
