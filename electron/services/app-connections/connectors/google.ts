/**
 * Google Drive connector — Plan 312 Phase 3.
 *
 * A cohesive read workflow: search candidates, inspect metadata, then read
 * selected text content. Every successful response contains a stable Drive URL
 * so the Agent can cite the source. Tokens never leave the main process.
 */

import type { ConnectorInputSchema } from '../connector-types.js';
import type {
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId } from '../types.js';

const PROVIDER: ProviderId = 'google';
const DRIVE_SEARCH_ACTION = 'drive.search';
const DRIVE_GET_ACTION = 'drive.get';
const DRIVE_READ_ACTION = 'drive.read';

const DRIVE_FILE_FIELDS = [
  'id', 'name', 'mimeType', 'modifiedTime', 'webViewLink',
  'capabilities/canDownload',
].join(',');

const FILE_TYPE_MIME_TYPES = {
  document: 'application/vnd.google-apps.document',
  spreadsheet: 'application/vnd.google-apps.spreadsheet',
  presentation: 'application/vnd.google-apps.presentation',
  pdf: 'application/pdf',
  folder: 'application/vnd.google-apps.folder',
} as const;

type GoogleDriveFileType = keyof typeof FILE_TYPE_MIME_TYPES;

interface GoogleDriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  capabilities?: { canDownload?: boolean };
}

interface GoogleDriveSource {
  id: string;
  title: string;
  url: string;
  mimeType: string;
  modifiedTime?: string;
}

const driveSearchSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Words to find in file names and text content. Omit to browse recent files.' },
    fileTypes: { type: 'array', description: 'Optional file types: document, spreadsheet, presentation, pdf, folder.', items: { type: 'string' } },
    folderId: { type: 'string', description: 'Optional parent Google Drive folder ID to search inside.' },
    modifiedAfter: { type: 'string', description: 'Optional ISO-8601 timestamp. Only return files modified after this time.' },
    pageSize: { type: 'number', description: 'Max candidates to return (1-25). Default 10.' },
  },
  required: [],
};

const driveFileReferenceSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    fileId: { type: 'string', description: 'Google Drive file ID. Provide this or a Google Drive URL.' },
    url: { type: 'string', description: 'Google Drive, Docs, Sheets, or Slides URL. Provide this or fileId.' },
  },
  required: [],
};

const driveReadSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    ...driveFileReferenceSchema.properties,
    maxCharacters: { type: 'number', description: 'Maximum returned characters (1,000-50,000). Default 20,000.' },
  },
  required: [],
};

/** Build the descriptor list for a single connection. */
export function listGoogleDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return [
    {
      name: 'google_drive_search',
      description: 'Search connected Google Drive files by words, type, folder, or modification time. Read-only. Use this before reading a file.',
      inputSchema: driveSearchSchema,
      inputSchemaSummary: 'query?: string; fileTypes?: document|spreadsheet|presentation|pdf|folder[]; folderId?: string; modifiedAfter?: ISO timestamp; pageSize?: number (1-25, default 10). Returns source metadata with stable Drive URLs.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: DRIVE_SEARCH_ACTION,
    },
    {
      name: 'google_drive_get',
      description: 'Get metadata and a source link for one Google Drive file. Read-only.',
      inputSchema: driveFileReferenceSchema,
      inputSchemaSummary: 'fileId?: string or url?: Google Drive/Docs/Sheets/Slides URL. Returns a source object.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: DRIVE_GET_ACTION,
    },
    {
      name: 'google_drive_read',
      description: 'Read text from one selected Google Drive file. Supports Google Docs, Sheets, Slides, and text-based files. Always cite the returned source.url when using its content. Read-only.',
      inputSchema: driveReadSchema,
      inputSchemaSummary: 'fileId?: string or url?: Google URL; maxCharacters?: number (1,000-50,000). Returns text plus source.url for citation.',
      riskTier: 'read',
      provider: PROVIDER,
      connectionId,
      action: DRIVE_READ_ACTION,
    },
  ];
}

async function searchDriveFiles(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const input = asRecord(args);
  const query = stringValue(input.query);
  const folderId = stringValue(input.folderId);
  const modifiedAfter = stringValue(input.modifiedAfter);
  const fileTypes = getFileTypes(input.fileTypes);
  const pageSize = clampNumber(input.pageSize, 10, 1, 25);
  if (folderId && !isDriveId(folderId)) return invalidArguments('folderId must be a Google Drive folder ID');

  const clauses = ['trashed = false'];
  if (query) clauses.push("fullText contains '" + escapeDriveQuery(query) + "'");
  if (folderId) clauses.push("'" + folderId + "' in parents");
  if (fileTypes.length > 0) {
    const mimeClauses = fileTypes.map((fileType) => "mimeType = '" + FILE_TYPE_MIME_TYPES[fileType] + "'");
    clauses.push('(' + mimeClauses.join(' or ') + ')');
  }
  if (modifiedAfter) {
    const date = new Date(modifiedAfter);
    if (Number.isNaN(date.getTime())) return invalidArguments('modifiedAfter must be an ISO-8601 timestamp');
    clauses.push("modifiedTime > '" + date.toISOString() + "'");
  }

  const url = new URL('https://www.googleapis.com/drive/v3/files');
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('q', clauses.join(' and '));
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('fields', 'nextPageToken,incompleteSearch,files(' + DRIVE_FILE_FIELDS + ')');
  url.searchParams.set('supportsAllDrives', 'true');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return googleFailure('search files', response.status);
  const data = (await response.json()) as { files?: GoogleDriveFile[]; nextPageToken?: string; incompleteSearch?: boolean };
  return {
    success: true,
    data: {
      files: (data.files ?? []).flatMap((file) => {
        const source = toSource(file);
        return source ? [source] : [];
      }),
      nextPageToken: data.nextPageToken,
      incompleteSearch: data.incompleteSearch === true,
    },
  };
}

async function getDriveFile(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const fileId = resolveFileId(args);
  if (!fileId.success) return fileId.result;
  const result = await fetchDriveFile(fileId.data, accessToken, fetchImpl);
  if (!result.success) return result.result;
  const source = toSource(result.data);
  return source ? { success: true, data: source } : invalidArguments('Google Drive did not return a valid file record');
}

async function readDriveFile(args: unknown, accessToken: string, fetchImpl: typeof fetch): Promise<ConnectorInvokeResult> {
  const fileId = resolveFileId(args);
  if (!fileId.success) return fileId.result;
  const maxCharacters = clampNumber(asRecord(args).maxCharacters, 20_000, 1_000, 50_000);
  const fileResult = await fetchDriveFile(fileId.data, accessToken, fetchImpl);
  if (!fileResult.success) return fileResult.result;
  const source = toSource(fileResult.data);
  if (!source) return invalidArguments('Google Drive did not return a valid file record');
  if (fileResult.data.capabilities?.canDownload === false) {
    return unsupportedFile('Google Drive does not permit this file to be downloaded or exported');
  }
  const readUrl = buildReadUrl(source.id, source.mimeType);
  if (!readUrl) return unsupportedFile('Unsupported file type for text reading: ' + source.mimeType);
  const response = await fetchImpl(readUrl, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return googleFailure('read file', response.status);
  const content = await response.text();
  return {
    success: true,
    data: {
      source,
      content: content.slice(0, maxCharacters),
      truncated: content.length > maxCharacters,
      characterCount: content.length,
    },
  };
}

async function fetchDriveFile(fileId: string, accessToken: string, fetchImpl: typeof fetch): Promise<{ success: true; data: GoogleDriveFile } | { success: false; result: ConnectorInvokeResult }> {
  const url = new URL('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId));
  url.searchParams.set('fields', DRIVE_FILE_FIELDS);
  url.searchParams.set('supportsAllDrives', 'true');
  const response = await fetchImpl(url.toString(), { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) return { success: false, result: googleFailure('get file', response.status) };
  return { success: true, data: (await response.json()) as GoogleDriveFile };
}

function buildReadUrl(fileId: string, mimeType: string): string | null {
  const exportMimeType = googleWorkspaceExportMimeType(mimeType);
  if (exportMimeType) {
    const url = new URL('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '/export');
    url.searchParams.set('mimeType', exportMimeType);
    return url.toString();
  }
  if (!isTextMimeType(mimeType)) return null;
  const url = new URL('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId));
  url.searchParams.set('alt', 'media');
  return url.toString();
}

function googleWorkspaceExportMimeType(mimeType: string): string | null {
  switch (mimeType) {
    case 'application/vnd.google-apps.document': return 'text/plain';
    case 'application/vnd.google-apps.spreadsheet': return 'text/csv';
    case 'application/vnd.google-apps.presentation': return 'text/plain';
    default: return null;
  }
}

function isTextMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/javascript',
  ].includes(mimeType);
}

function resolveFileId(args: unknown): { success: true; data: string } | { success: false; result: ConnectorInvokeResult } {
  const input = asRecord(args);
  const fileId = stringValue(input.fileId);
  if (fileId) return isDriveId(fileId)
    ? { success: true, data: fileId }
    : { success: false, result: invalidArguments('fileId is not a valid Google Drive file ID') };
  const url = stringValue(input.url);
  if (!url) return { success: false, result: invalidArguments('Provide fileId or a Google Drive URL') };
  const urlFileId = extractGoogleDriveFileId(url);
  return urlFileId
    ? { success: true, data: urlFileId }
    : { success: false, result: invalidArguments('url must be a Google Drive, Docs, Sheets, or Slides URL') };
}

function extractGoogleDriveFileId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.hostname !== 'drive.google.com' && url.hostname !== 'docs.google.com') return null;
    const matched = url.pathname.match(/\/(?:file|document|spreadsheets|presentation|drawings)\/d\/([A-Za-z0-9_-]+)/)
      ?? url.pathname.match(/\/drive\/folders\/([A-Za-z0-9_-]+)/);
    const candidate = matched?.[1] ?? url.searchParams.get('id');
    return candidate && isDriveId(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function toSource(file: GoogleDriveFile): GoogleDriveSource | null {
  if (!file.id || !isDriveId(file.id)) return null;
  return {
    id: file.id,
    title: file.name ?? file.id,
    url: file.webViewLink ?? 'https://drive.google.com/open?id=' + encodeURIComponent(file.id),
    mimeType: file.mimeType ?? 'application/octet-stream',
    ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || undefined;
}

function getFileTypes(value: unknown): GoogleDriveFileType[] {
  if (!Array.isArray(value)) return [];
  const fileTypes: GoogleDriveFileType[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item in FILE_TYPE_MIME_TYPES) fileTypes.push(item as GoogleDriveFileType);
  }
  return [...new Set(fileTypes)];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
}

function escapeDriveQuery(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isDriveId(value: string): boolean {
  return /^[A-Za-z0-9_-]{3,}$/.test(value);
}

function googleFailure(action: string, status: number): ConnectorInvokeResult {
  return {
    success: false,
    error: { code: 'http_' + status, message: 'Google Drive ' + action + ' failed: ' + status, retriable: status >= 500 },
  };
}

function invalidArguments(message: string): ConnectorInvokeResult {
  return { success: false, error: { code: 'invalid_arguments', message, retriable: false } };
}

function unsupportedFile(message: string): ConnectorInvokeResult {
  return { success: false, error: { code: 'unsupported_file', message, retriable: false } };
}

/** Construct a Google connector module bound to a custom fetch (tests). */
export function createGoogleConnector(fetchImpl: typeof fetch = fetch): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listGoogleDescriptors(connectionId);
    },
    async invoke(action: string, args: unknown, accessToken: string): Promise<ConnectorInvokeResult> {
      if (action === DRIVE_SEARCH_ACTION) return searchDriveFiles(args, accessToken, fetchImpl);
      if (action === DRIVE_GET_ACTION) return getDriveFile(args, accessToken, fetchImpl);
      if (action === DRIVE_READ_ACTION) return readDriveFile(args, accessToken, fetchImpl);
      return {
        success: false,
        error: { code: 'unknown_action', message: 'Unknown google action: ' + action, retriable: false },
      };
    },
  };
}
