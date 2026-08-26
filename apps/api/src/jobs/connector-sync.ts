import { decryptSecret } from '@uxe/auth';
import type { TenantContext } from '@uxe/db';
import type { AppDeps } from '../context.js';
import { buildStorageKey } from '../services/storage.js';
import {
  FILE_STORES,
  FileStoreClient,
  FileStoreError,
  fileStoreConfig,
  type FetchLike,
  type RemoteFile,
} from '../services/file-store.js';

/** Extensions the document worker can read. Anything else is skipped, not failed. */
const SUPPORTED = new Set([
  'pdf',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'ppt',
  'csv',
  'txt',
  'md',
  'html',
  'htm',
  'png',
  'jpg',
  'jpeg',
  'tif',
  'tiff',
]);

/** Ceilings on one run, so a large account cannot hold the queue for an unbounded time. */
const MAX_FILES_PER_RUN = 200;
const MAX_BYTES_PER_FILE = 100 * 1024 * 1024;

export interface ConnectorSyncOutcome {
  imported: number;
  skipped: number;
  alreadyPresent: number;
  failed: number;
  /** Named rather than counted, because "12 files were skipped" tells nobody which. */
  notes: string[];
}

/**
 * Imports what is in a connected account into the knowledge base.
 *
 * Every file becomes an ordinary source with an ordinary ingest job, so a document that
 * arrived from Drive is indexed, cited and corrected by exactly the same path as one that
 * was dragged into the browser. Nothing about being remote makes it a second kind of
 * document once it is here.
 *
 * A file already imported at the same content hash is left alone: re-running a sync is a
 * normal thing to do and must not multiply the library.
 */
export async function runConnectorSync(
  deps: AppDeps,
  tenant: TenantContext,
  input: { connectorId: string; fetchImpl?: FetchLike },
): Promise<ConnectorSyncOutcome> {
  const connector = await deps.repos.connectors.getById(tenant, input.connectorId);
  const store = FILE_STORES.find((s) => s.kind === connector.kind);
  if (!store) throw new Error(`Unknown connector kind: ${connector.kind}`);

  const config = fileStoreConfig(deps.env, store.kind);
  if (!config) {
    throw new FileStoreError(
      `${store.label} is no longer configured for this deployment.`,
      400,
      false,
    );
  }

  const encrypted = await deps.repos.connectors.credentialFor(tenant.workspaceId, connector.id);
  if (!encrypted) {
    throw new FileStoreError(
      `${store.label} has no stored authorisation. Reconnect it in Settings.`,
      401,
      false,
    );
  }

  await deps.repos.connectors.setStatus(connector.id, 'syncing', { lastError: null });

  const outcome: ConnectorSyncOutcome = {
    imported: 0,
    skipped: 0,
    alreadyPresent: 0,
    failed: 0,
    notes: [],
  };

  try {
    const refreshToken = await decryptSecret(encrypted, deps.env.ENCRYPTION_KEY);
    const accessToken = await FileStoreClient.accessTokenFrom(
      store,
      config,
      refreshToken,
      input.fetchImpl,
    );
    const client = new FileStoreClient(store, accessToken, input.fetchImpl);

    let pageToken: string | null = null;
    let seen = 0;

    do {
      const page: Awaited<ReturnType<FileStoreClient['listFiles']>> =
        await client.listFiles(pageToken);
      for (const file of page.files) {
        if (seen >= MAX_FILES_PER_RUN) break;
        seen += 1;
        await importOne(deps, tenant, client, connector.id, store.kind, file, outcome);
      }
      pageToken = seen >= MAX_FILES_PER_RUN ? null : page.nextPageToken;
    } while (pageToken);

    if (seen >= MAX_FILES_PER_RUN) {
      // Said plainly rather than left as a silent truncation: a run that stopped early
      // and a run that finished look identical from a count alone.
      outcome.notes.push(
        `Stopped after ${MAX_FILES_PER_RUN} files. Run the sync again to continue.`,
      );
    }

    await deps.repos.connectors.setStatus(connector.id, 'connected', {
      lastError: null,
      lastSyncedAt: new Date(),
    });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The sync failed.';
    await deps.repos.connectors.setStatus(connector.id, 'error', { lastError: message });
    throw error;
  }
}

async function importOne(
  deps: AppDeps,
  tenant: TenantContext,
  client: FileStoreClient,
  connectorId: string,
  connectorKind: string,
  file: RemoteFile,
  outcome: ConnectorSyncOutcome,
): Promise<void> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!SUPPORTED.has(extension)) {
    outcome.skipped += 1;
    outcome.notes.push(`Skipped ${file.name}: this file type is not readable.`);
    return;
  }
  if (file.sizeBytes !== null && file.sizeBytes > MAX_BYTES_PER_FILE) {
    outcome.skipped += 1;
    outcome.notes.push(`Skipped ${file.name}: larger than 100MB.`);
    return;
  }

  try {
    const bytes = await client.download(file);

    const key = buildStorageKey({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      kind: 'source',
      id: file.externalId,
      fileName: file.name,
    });
    const stored = await deps.services.storage.put(
      'originals',
      key,
      bytes,
      file.mimeType || 'application/octet-stream',
    );

    // The content hash, not the file name or its remote id, decides whether this is new.
    // A renamed file with unchanged contents is the same document.
    const duplicate = await deps.repos.sources.findDuplicateInWorkspace(tenant, stored.sha256);
    if (duplicate) {
      outcome.alreadyPresent += 1;
      return;
    }

    const source = await deps.repos.sources.create(tenant, {
      title: file.name.replace(/\.[A-Za-z0-9]{1,6}$/, '') || file.name,
      documentType: documentTypeFor(extension),
      promotedToKnowledge: true,
      connectorId,
      connectorKind,
      status: 'pending',
    });

    const { version } = await deps.repos.sources.createVersion(tenant, {
      sourceId: source.id,
      sha256: stored.sha256,
      storageKey: stored.key,
      contentType: file.mimeType || 'application/octet-stream',
      sizeBytes: stored.sizeBytes,
    });

    await deps.repos.jobs.enqueue(tenant, {
      kind: 'source_ingest',
      idempotencyKey: `ingest:${version.id}`,
      payload: {
        sourceId: source.id,
        sourceVersionId: version.id,
        storageKey: stored.key,
        fileName: file.name,
        contentType: file.mimeType || 'application/octet-stream',
      },
      targetType: 'source',
      targetId: source.id,
    });

    outcome.imported += 1;
  } catch (error) {
    // One unreadable file must not abandon the rest of the account.
    outcome.failed += 1;
    outcome.notes.push(
      `${file.name}: ${error instanceof Error ? error.message : 'could not be imported'}`,
    );
  }
}

function documentTypeFor(extension: string): string {
  if (extension === 'pdf') return 'pdf';
  if (extension === 'docx' || extension === 'doc') return 'docx';
  if (extension === 'xlsx' || extension === 'xls') return 'xlsx';
  if (extension === 'pptx' || extension === 'ppt') return 'pptx';
  if (extension === 'csv') return 'csv';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'md') return 'markdown';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff'].includes(extension)) return 'image';
  return 'text';
}
