import type { Permission, Role } from '@uxe/contracts';
import { roleHasPermission } from '@uxe/contracts';

/**
 * The only way to address tenant data. Every field is derived from the authenticated
 * session on the server; nothing here may be populated from a request body, query string
 * or header supplied by the client.
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: Role;
  /** Group memberships, used to resolve group-scoped source ACLs. */
  readonly groupIds: readonly string[];
  readonly traceId: string;
}

export class AuthorizationError extends Error {
  readonly code = 'forbidden' as const;
  readonly status = 403;
  constructor(
    public readonly permission: Permission | string,
    message = 'You do not have permission to perform this action',
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class NotFoundError extends Error {
  readonly code = 'not_found' as const;
  readonly status = 404;
  constructor(public readonly resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
  }
}

/**
 * Raised when something that is not in the knowledge base is asked to govern a review.
 *
 * The compliance authority is the knowledge base and nothing else. A document uploaded
 * inside a consultation is the submission under inspection; letting it define the rules it
 * is measured against would let a drawing certify itself.
 */
export class NotAuthorityError extends Error {
  readonly code = 'not_authority' as const;
  readonly status = 422;
  constructor(public readonly sourceId: string) {
    super(
      'Only a document published to the knowledge base can govern a compliance review. Upload it on the Knowledge page first.',
    );
    this.name = 'NotAuthorityError';
  }
}

export class VersionConflictError extends Error {
  readonly code = 'version_conflict' as const;
  readonly status = 409;
  constructor(
    public readonly resource: string,
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(
      `${resource} was modified by someone else. You had version ${expected}, the current version is ${actual}.`,
    );
    this.name = 'VersionConflictError';
  }
}

/**
 * Throws unless the context's role carries the permission.
 *
 * Called at the top of every mutating repository method rather than in the HTTP layer,
 * so a new caller (a queue consumer, a scheduled job, a future gRPC surface) cannot
 * accidentally bypass the check by not going through a route handler.
 */
export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!roleHasPermission(ctx.role, permission)) {
    throw new AuthorizationError(permission);
  }
}

export function hasPermission(ctx: TenantContext, permission: Permission): boolean {
  return roleHasPermission(ctx.role, permission);
}

/**
 * A resource row must belong to the context's workspace AND organization. Checking both
 * means a bug that leaks a workspace ID across organizations still fails closed.
 */
export function assertSameTenant(
  ctx: TenantContext,
  row: { organizationId?: string | null; workspaceId?: string | null } | null | undefined,
  resource: string,
): void {
  if (!row) throw new NotFoundError(resource);
  if (row.workspaceId != null && row.workspaceId !== ctx.workspaceId) {
    // Reported as not-found so the existence of another tenant's row is never disclosed.
    throw new NotFoundError(resource);
  }
  if (row.organizationId != null && row.organizationId !== ctx.organizationId) {
    throw new NotFoundError(resource);
  }
}
