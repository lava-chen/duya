/**
 * Google Workspace connector — Plan 312 Phase 3.
 *
 * Smoke toolset (read-only). The full Google Workspace tool catalog
 * (Drive / Gmail / Calendar) belongs to Plan 313; this ships only
 * `google_drive_list_files` so the end-to-end tool injection chain
 * can be exercised.
 */

import type { ConnectorInputSchema } from '../connector-types.js';
import type {
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';

const PROVIDER: ProviderId = 'google';

const DRIVE_LIST_FILES_ACTION = 'drive.list_files';

const driveListFilesSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    pageSize: {
      type: 'number',
      description: 'Max number of files to return (1-100). Default 20.',
    },
    query: {
      type: 'string',
      description: 'Optional Google Drive query string (e.g. `mimeType=\'application/vnd.google-apps.document\'`).',
    },
  },
  required: [],
};

/** Build the descriptor list for a single connection. */
export function listGoogleDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'google_drive_list_files',
      description: 'List files from the connected Google Drive account. Read-only.',
      inputSchema: driveListFilesSchema,
      inputSchemaSummary:
        'pageSize?: number (1-100, default 20); query?: string (Drive Q syntax). ' +
        'Returns a JSON list of file metadata {id, name, mimeType, modifiedTime}.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: DRIVE_LIST_FILES_ACTION,
    },
  ];
}

async function listDriveFiles(
  args: { pageSize?: number; query?: string },
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<ConnectorInvokeResult> {
  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(Math.min(100, Math.max(1, args.pageSize ?? 20))));
  url.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime)');
  if (args.query) url.searchParams.set('q', args.query);

  const resp = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    return {
      success: false,
      error: {
        code: `http_${resp.status}`,
        message: `Google Drive list files failed: ${resp.status}`,
        retriable: resp.status >= 500,
      },
    };
  }
  const data = (await resp.json()) as { files?: Array<Record<string, unknown>> };
  return { success: true, data: data.files ?? [] };
}

/** Construct a Google connector module bound to a custom fetch (tests). */
export function createGoogleConnector(fetchImpl: typeof fetch = fetch): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listGoogleDescriptors(connectionId);
    },
    async invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult> {
      if (action === DRIVE_LIST_FILES_ACTION) {
        const typed = (args ?? {}) as { pageSize?: number; query?: string };
        return listDriveFiles(typed, accessToken, fetchImpl);
      }
      return {
        success: false,
        error: { code: 'unknown_action', message: `Unknown google action: ${action}`, retriable: false },
      };
    },
  };
}
