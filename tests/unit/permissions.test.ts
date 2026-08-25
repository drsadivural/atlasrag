import { describe, expect, it } from 'vitest';
import {
  PERMISSIONS,
  ROLE_LABELS,
  ROLE_ORDER,
  canAssignRole,
  permissionsForRole,
  rankOfRole,
  roleHasPermission,
  type Permission,
  type Role,
} from '@uxe/contracts';

describe('role permissions', () => {
  it('gives every role a label and a permission set', () => {
    for (const role of ROLE_ORDER) {
      expect(ROLE_LABELS[role]).toBeTruthy();
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });

  it('never grants a permission that is not in the declared list', () => {
    const known = new Set<string>(PERMISSIONS);
    for (const role of ROLE_ORDER) {
      for (const permission of permissionsForRole(role)) {
        expect(known.has(permission)).toBe(true);
      }
    }
  });

  it('orders roles from most to least privileged', () => {
    expect(rankOfRole('owner')).toBeLessThan(rankOfRole('admin'));
    expect(rankOfRole('admin')).toBeLessThan(rankOfRole('member'));
    expect(rankOfRole('member')).toBeLessThan(rankOfRole('read_only'));
  });

  it('gives the Owner a superset of every other role', () => {
    const owner = new Set(permissionsForRole('owner'));
    for (const role of ROLE_ORDER) {
      for (const permission of permissionsForRole(role)) {
        expect(owner.has(permission)).toBe(true);
      }
    }
  });

  describe('read_only', () => {
    it('can read but cannot mutate anything', () => {
      const mutating: Permission[] = [
        'source:create',
        'source:update',
        'source:delete',
        'consultation:create',
        'consultation:update',
        'review:create',
        'correction:create',
        'correction:generate',
        'settings:update',
        'member:invite',
      ];
      for (const permission of mutating) {
        expect(roleHasPermission('read_only', permission)).toBe(false);
      }
      expect(roleHasPermission('read_only', 'source:read')).toBe(true);
      expect(roleHasPermission('read_only', 'consultation:read')).toBe(true);
    });

    it('cannot download artifacts', () => {
      // Reading the library is fine; extracting a document out of the tenant is not.
      expect(roleHasPermission('read_only', 'artifact:read')).toBe(true);
      expect(roleHasPermission('read_only', 'artifact:download')).toBe(false);
    });
  });

  describe('role separation', () => {
    it('lets a Knowledge Manager own sources but not run reviews', () => {
      expect(roleHasPermission('knowledge_manager', 'source:delete')).toBe(true);
      expect(roleHasPermission('knowledge_manager', 'source:permissions')).toBe(true);
      expect(roleHasPermission('knowledge_manager', 'review:create')).toBe(false);
      expect(roleHasPermission('knowledge_manager', 'correction:generate')).toBe(false);
    });

    it('lets a Reviewer approve findings and see every consultation, but not author sources', () => {
      expect(roleHasPermission('reviewer', 'review:approve')).toBe(true);
      expect(roleHasPermission('reviewer', 'consultation:read_all')).toBe(true);
      expect(roleHasPermission('reviewer', 'correction:decide')).toBe(true);
      expect(roleHasPermission('reviewer', 'source:create')).toBe(false);
    });

    it('lets a Consultant run the client-facing workflow end to end', () => {
      for (const permission of [
        'review:create',
        'correction:create',
        'correction:generate',
        'report:create',
      ] as Permission[]) {
        expect(roleHasPermission('consultant', permission)).toBe(true);
      }
    });

    it('does not let a Member read other people’s consultations', () => {
      expect(roleHasPermission('member', 'consultation:read')).toBe(true);
      expect(roleHasPermission('member', 'consultation:read_all')).toBe(false);
    });

    it('reserves workspace deletion and retention purge for the Owner', () => {
      expect(roleHasPermission('owner', 'workspace:delete')).toBe(true);
      expect(roleHasPermission('admin', 'workspace:delete')).toBe(false);
      expect(roleHasPermission('owner', 'retention:purge')).toBe(true);
      expect(roleHasPermission('admin', 'retention:purge')).toBe(false);
    });
  });

  describe('canAssignRole', () => {
    it('stops an Admin promoting anyone to Owner, including themselves', () => {
      expect(canAssignRole('admin', 'member', 'owner')).toBe(false);
      expect(canAssignRole('admin', 'admin', 'owner')).toBe(false);
    });

    it('stops an Admin demoting an Owner', () => {
      expect(canAssignRole('admin', 'owner', 'member')).toBe(false);
    });

    it('lets an Admin manage roles at or below their own level', () => {
      expect(canAssignRole('admin', 'member', 'consultant')).toBe(true);
      expect(canAssignRole('admin', 'read_only', 'admin')).toBe(true);
    });

    it('lets an Owner assign any role', () => {
      for (const role of ROLE_ORDER) {
        expect(canAssignRole('owner', 'member', role)).toBe(true);
      }
    });

    it('refuses every role change from a role without member:update', () => {
      for (const actor of [
        'member',
        'read_only',
        'reviewer',
        'knowledge_manager',
        'consultant',
      ] as Role[]) {
        expect(canAssignRole(actor, 'member', 'member')).toBe(false);
      }
    });
  });
});
