import { Hono } from 'hono';
import {
  ConnectorAuthorizeRequest,
  ConnectorCallbackQuery,
  FileStoreKind,
  type ConnectorProvider,
  type ConnectorsResponse,
} from '@uxe/contracts';
import {
  buildAuthorizationRequest,
  encryptSecret,
  exchangeCode,
  fetchProfile,
  sha256Hex,
  type OAuthConfig,
  type OAuthProvider,
} from '@uxe/auth';
import type { AppBindings, AppDeps } from '../context.js';
import { ApiError } from '../errors.js';
import { body, query, requireId, validateJson, validateQuery } from '../middleware/validate.js';
import { requirePermission, userAgent, clientIp } from '../middleware/index.js';
import { toJobView } from './jobs.js';
import { FILE_STORES, fileStoreConfig, type FileStoreDefinition } from '../services/file-store.js';

/**
 * The file stores a workspace can attach: Google Drive, OneDrive and SharePoint.
 *
 * Two things are deliberately kept apart here. Whether the *deployment* has an OAuth
 * application for a provider is an operator's concern, fixed by setting two environment
 * variables. Whether a *workspace* has connected one is an administrator's, fixed by
 * clicking through a consent screen. Reporting them as one "unavailable" state would send
 * whoever hit it looking in the wrong place.
 */
export function connectorRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/', requirePermission('settings:read'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();

    const rows = await deps.repos.connectors.list(tenant);
    const byKind = new Map(rows.map((row) => [row.kind, row]));

    const providers: ConnectorProvider[] = FILE_STORES.map((store) => {
      const row = byKind.get(store.kind);
      const config = fileStoreConfig(deps.env, store.kind);
      return {
        kind: store.kind,
        label: store.label,
        description: store.description,
        available: config !== null,
        requiredEnv: store.requiredEnv,
        redirectUri: redirectUriFor(deps),
        scopes: store.scopes,
        connection: row
          ? {
              id: row.id,
              status: (row.status === 'connected' ||
              row.status === 'error' ||
              row.status === 'syncing'
                ? row.status
                : 'disconnected') as ConnectorProvider['connection'] extends null
                ? never
                : 'connected' | 'error' | 'syncing' | 'disconnected',
              accountEmail: row.accountEmail,
              displayName: row.displayName,
              rootPath: typeof row.config.rootPath === 'string' ? row.config.rootPath : '/',
              lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
              lastError: row.lastError,
              createdAt: row.createdAt.toISOString(),
              version: row.version,
            }
          : null,
      };
    });

    return c.json({ providers } satisfies ConnectorsResponse);
  });

  /**
   * Starts the consent flow.
   *
   * The state token carries the workspace, so the callback does not have to trust a
   * cookie that a provider redirect may or may not send, and it is single use, so a
   * replayed callback cannot attach a second grant.
   */
  app.post(
    '/:kind/authorize',
    requirePermission('settings:connectors'),
    validateJson(ConnectorAuthorizeRequest),
    async (c) => {
      const tenant = c.get('tenant');
      if (!tenant) throw ApiError.unauthenticated();

      const store = requireStore(c.req.param('kind'));
      const config = fileStoreConfig(deps.env, store.kind);
      if (!config) throw unconfigured(store);

      const request = await buildAuthorizationRequest(store.provider, withRedirect(config, deps), {
        extraScopes: store.scopes,
        offlineAccess: true,
      });

      await deps.repos.identity.createAuthToken({
        userId: tenant.userId,
        email: null,
        kind: 'connector_state',
        tokenHash: await sha256Hex(request.state),
        ttlMinutes: 10,
        metadata: {
          kind: store.kind,
          codeVerifier: request.codeVerifier,
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          returnTo: body<typeof ConnectorAuthorizeRequest._output>(c).returnTo,
        },
      });

      return c.json({ authorizeUrl: request.url });
    },
  );

  app.delete('/:id', requirePermission('settings:connectors'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');

    const connector = await deps.repos.connectors.getById(tenant, id);
    await deps.repos.connectors.disconnect(tenant, id);

    await deps.repos.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: tenant.userId,
      actorName: c.get('session')?.user.fullName ?? 'Unknown',
      action: 'connector.disconnect',
      category: 'settings',
      targetType: 'connector',
      targetId: id,
      targetLabel: connector.displayName,
      ipAddress: clientIp(c),
      userAgent: userAgent(c),
      traceId: c.get('traceId') ?? 'unknown',
      summary: `Disconnected ${connector.displayName}. Documents already imported from it are unaffected.`,
    });

    return c.body(null, 204);
  });

  /** Imports whatever has changed in the connected account since the last run. */
  app.post('/:id/sync', requirePermission('settings:connectors'), async (c) => {
    const tenant = c.get('tenant');
    if (!tenant) throw ApiError.unauthenticated();
    const id = requireId(c, 'id');

    const connector = await deps.repos.connectors.getById(tenant, id);
    if (connector.status === 'disconnected') {
      throw ApiError.badRequest('Reconnect this account before syncing it.');
    }

    // Keyed on the connector, so two clicks a second apart join the same run rather than
    // starting a second pass over the same account.
    const { job } = await deps.repos.jobs.enqueue(tenant, {
      kind: 'connector_sync',
      idempotencyKey: `connector-sync:${id}`,
      payload: { connectorId: id, kind: connector.kind },
      targetType: 'connector',
      targetId: id,
    });

    return c.json({ job: toJobView(job) }, 202);
  });

  return app;
}

/**
 * The provider's redirect target, mounted outside the authenticated area.
 *
 * A provider sends the browser here with no guarantee about cookies, so the request is
 * identified entirely by the single-use state token minted when the flow started.
 */
export function connectorCallbackRoutes(deps: AppDeps) {
  const app = new Hono<AppBindings>();

  app.get('/callback', validateQuery(ConnectorCallbackQuery), async (c) => {
    const input = query<typeof ConnectorCallbackQuery._output>(c);
    const back = (path: string, params: Record<string, string>) =>
      c.redirect(`${deps.env.PUBLIC_APP_URL}${path}?${new URLSearchParams(params)}`, 302);

    const stored = await deps.repos.identity.consumeAuthToken(
      await sha256Hex(input.state),
      'connector_state',
    );
    const metadata = (stored?.metadata ?? {}) as {
      kind?: string;
      codeVerifier?: string;
      organizationId?: string;
      workspaceId?: string;
      returnTo?: string;
    };
    const returnTo = metadata.returnTo ?? '/settings/connectors';

    if (!stored || !metadata.kind || !metadata.codeVerifier || !metadata.workspaceId) {
      return back('/settings/connectors', { connector: 'failed', reason: 'expired' });
    }
    if (input.error) {
      // The account holder declined, or the provider refused. Either way it is their
      // answer, not a fault, so it is reported as a decision rather than an error.
      return back(returnTo, { connector: 'cancelled', kind: metadata.kind });
    }
    if (!input.code) {
      return back(returnTo, { connector: 'failed', kind: metadata.kind, reason: 'no_code' });
    }

    const store = FILE_STORES.find((s) => s.kind === metadata.kind);
    const config = store ? fileStoreConfig(deps.env, store.kind) : null;
    if (!store || !config) {
      return back(returnTo, { connector: 'failed', reason: 'not_configured' });
    }

    try {
      const tokens = await exchangeCode(
        store.provider,
        withRedirect(config, deps),
        input.code,
        metadata.codeVerifier,
      );

      if (!tokens.refreshToken) {
        // Without one the grant expires within the hour and every later sync fails. Better
        // to refuse the connection now than to record one that quietly stops working.
        return back(returnTo, {
          connector: 'failed',
          kind: store.kind,
          reason: 'no_refresh_token',
        });
      }

      const profile = await fetchProfile(
        store.provider,
        withRedirect(config, deps),
        tokens.accessToken,
      );
      const credential = await encryptSecret(tokens.refreshToken, deps.env.ENCRYPTION_KEY);

      await deps.repos.connectors.connect(
        // Reconstructed from the state token, not from a request header: the browser
        // arriving here came from the provider, and the workspace it belongs to was
        // settled when the flow started.
        {
          organizationId: metadata.organizationId ?? '',
          workspaceId: metadata.workspaceId,
          userId: stored.userId ?? '',
          role: 'admin',
          groupIds: [],
          traceId: c.get('traceId') ?? 'connector-callback',
        },
        {
          kind: store.kind,
          displayName: store.label,
          accountEmail: profile.email,
          credentialEncrypted: credential,
          config: { rootPath: '/' },
        },
      );

      return back(returnTo, { connector: 'connected', kind: store.kind });
    } catch (error) {
      deps.logger.warn('connector.callback_failed', {
        kind: store.kind,
        error: error instanceof Error ? error.message : 'unknown',
      });
      return back(returnTo, { connector: 'failed', kind: store.kind, reason: 'exchange_failed' });
    }
  });

  return app;
}

function requireStore(kind: string | undefined): FileStoreDefinition {
  const parsed = FileStoreKind.safeParse(kind);
  if (!parsed.success) throw ApiError.notFound('Connector');
  const store = FILE_STORES.find((s) => s.kind === parsed.data);
  if (!store) throw ApiError.notFound('Connector');
  return store;
}

function unconfigured(store: FileStoreDefinition): ApiError {
  return new ApiError(
    400,
    'provider_unconfigured',
    `${store.label} needs an OAuth application for this deployment. Register one with ${store.provider === 'google' ? 'Google' : 'Microsoft'}, then set ${store.requiredEnv.join(' and ')}.`,
    { details: { connector: store.kind, requiredEnv: store.requiredEnv } },
  );
}

function redirectUriFor(deps: AppDeps): string {
  return `${deps.env.PUBLIC_API_URL}/api/v1/connectors/callback`;
}

/** One redirect URI for all three, because it is the connector flow that owns it. */
function withRedirect(config: OAuthConfig, deps: AppDeps): OAuthConfig {
  return { ...config, redirectUri: redirectUriFor(deps) };
}

export type { OAuthProvider };
