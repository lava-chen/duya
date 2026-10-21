import { describe, expect, it } from 'vitest';
import { createGoogleConnector, listGoogleDescriptors } from '../connectors/google';

describe('Google Drive connector', () => {
  it('exposes the search, metadata, and cited-read workflow', () => {
    expect(listGoogleDescriptors('google-1').map((descriptor) => descriptor.name)).toEqual([
      'google_drive_search',
      'google_drive_get',
      'google_drive_read',
    ]);
    expect(listGoogleDescriptors('google-1')[2]!.description).toContain('source.url');
  });

  it('compiles safe semantic search input to a Drive query and returns source links', async () => {
    const urls: string[] = [];
    const connector = createGoogleConnector((async (input) => {
      urls.push(input.toString());
      return new Response(JSON.stringify({
        files: [{
          id: 'drive-file-1',
          name: 'Q3 launch plan',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: '2026-08-01T00:00:00.000Z',
          webViewLink: 'https://docs.google.com/document/d/drive-file-1/edit',
        }, {
          id: 'not a drive id',
          name: 'Ignore malformed metadata',
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch);

    const result = await connector.invoke('drive.search', {
      query: "launch's plan",
      fileTypes: ['document'],
      folderId: 'folder-1',
      modifiedAfter: '2026-07-01T00:00:00.000Z',
      pageSize: 99,
    }, 'token');

    expect(result.success).toBe(true);
    const url = new URL(urls[0]!);
    expect(url.searchParams.get('pageSize')).toBe('25');
    expect(url.searchParams.get('q')).toContain("fullText contains 'launch\\'s plan'");
    expect(url.searchParams.get('q')).toContain("'folder-1' in parents");
    expect(result).toMatchObject({
      success: true,
      data: { files: [{ id: 'drive-file-1', url: 'https://docs.google.com/document/d/drive-file-1/edit' }] },
    });
    if (result.success) expect((result.data as { files: unknown[] }).files).toHaveLength(1);
  });

  it('reads a Google Doc URL via export and returns a bounded citation payload', async () => {
    const urls: string[] = [];
    const connector = createGoogleConnector((async (input) => {
      const url = input.toString();
      urls.push(url);
      if (url.includes('/export')) return new Response('A concise source document', { status: 200 });
      return new Response(JSON.stringify({
        id: 'drive-file-2',
        name: 'Brief',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://docs.google.com/document/d/drive-file-2/edit',
        capabilities: { canDownload: true },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch);

    const result = await connector.invoke('drive.read', {
      url: 'https://docs.google.com/document/d/drive-file-2/edit',
      maxCharacters: 1,
    }, 'token');

    expect(result).toMatchObject({
      success: true,
      data: {
        source: { id: 'drive-file-2', title: 'Brief', url: 'https://docs.google.com/document/d/drive-file-2/edit' },
        content: 'A concise source document',
        truncated: false,
      },
    });
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get('mimeType')).toBe('text/plain');
  });

  it('rejects URLs outside Google Drive instead of fetching them', async () => {
    const connector = createGoogleConnector((async () => {
      throw new Error('fetch should not be called');
    }) as typeof fetch);
    const result = await connector.invoke('drive.get', { url: 'https://example.com/file' }, 'token');
    expect(result).toMatchObject({ success: false, error: { code: 'invalid_arguments' } });
  });
});
