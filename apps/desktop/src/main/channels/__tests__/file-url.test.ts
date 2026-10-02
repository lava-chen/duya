/**
 * file-url.test.ts — unit tests for the file:// URL helpers (plan 507 P3.0).
 *
 * Pure functions, no electron / fs mocking needed. Drive-letter URLs are
 * normalized win32-style on every platform, so the expectations below hold
 * on both Windows and POSIX test runners.
 */
import { describe, it, expect } from 'vitest';

import {
  isFileUrl,
  fileUrlToPath,
  mediaTypeForPath,
  mimeTypeForPath,
} from '../file-url';

describe('isFileUrl', () => {
  it('accepts file:// URLs', () => {
    expect(isFileUrl('file:///C:/x/y.png')).toBe(true);
    expect(isFileUrl('file:///home/x/y.png')).toBe(true);
    expect(isFileUrl('file://localhost/C:/x/y.png')).toBe(true);
  });

  it('rejects non-file URLs and bare paths', () => {
    expect(isFileUrl('https://example.com/a.png')).toBe(false);
    expect(isFileUrl('http://example.com/a.png')).toBe(false);
    expect(isFileUrl('C:\\x\\y.png')).toBe(false);
    expect(isFileUrl('/home/x/y.png')).toBe(false);
    expect(isFileUrl('')).toBe(false);
  });
});

describe('fileUrlToPath', () => {
  it('converts Windows drive file URLs to win32 paths', () => {
    expect(fileUrlToPath('file:///C:/x/y.png')).toBe('C:\\x\\y.png');
    expect(fileUrlToPath('file:///d:/Users/bot/data.bin')).toBe('d:\\Users\\bot\\data.bin');
  });

  it('keeps POSIX-style paths as-is', () => {
    expect(fileUrlToPath('file:///home/x/y.png')).toBe('/home/x/y.png');
    expect(fileUrlToPath('file:///tmp/a b.png')).toBe('/tmp/a b.png');
  });

  it('percent-decodes the path portion', () => {
    expect(fileUrlToPath('file:///C:/my%20dir/a%20b.png')).toBe('C:\\my dir\\a b.png');
    expect(fileUrlToPath('file:///home/my%20dir/a.png')).toBe('/home/my dir/a.png');
  });

  it('treats localhost as the local machine', () => {
    expect(fileUrlToPath('file://localhost/C:/x/y.png')).toBe('C:\\x\\y.png');
    expect(fileUrlToPath('file://localhost/home/x/y.png')).toBe('/home/x/y.png');
  });

  it('throws on malformed input', () => {
    expect(() => fileUrlToPath('https://example.com/a.png')).toThrow(/Not a file/);
    expect(() => fileUrlToPath('not a url')).toThrow(/Malformed/);
    expect(() => fileUrlToPath('file://server/share/a.png')).toThrow(/remote host/);
    expect(() => fileUrlToPath('file:///')).toThrow(/no path/);
    expect(() => fileUrlToPath('file:///C:/a%zz.png')).toThrow(/percent-encoding/);
  });
});

describe('mediaTypeForPath', () => {
  it('maps image extensions to photo', () => {
    expect(mediaTypeForPath('C:\\shots\\a.png')).toBe('photo');
    expect(mediaTypeForPath('/home/x/a.jpg')).toBe('photo');
    expect(mediaTypeForPath('/home/x/a.webp')).toBe('photo');
  });

  it('maps audio extensions to voice', () => {
    expect(mediaTypeForPath('/home/x/note.mp3')).toBe('voice');
    expect(mediaTypeForPath('/home/x/note.ogg')).toBe('voice');
  });

  it('maps video extensions to video', () => {
    expect(mediaTypeForPath('/home/x/clip.mp4')).toBe('video');
    expect(mediaTypeForPath('/home/x/clip.webm')).toBe('video');
  });

  it('maps documents and unknown extensions to document', () => {
    expect(mediaTypeForPath('C:\\report.xlsx')).toBe('document');
    expect(mediaTypeForPath('/home/x/report.pdf')).toBe('document');
    expect(mediaTypeForPath('/home/x/data.unknownext')).toBe('document');
    expect(mediaTypeForPath('/home/x/noext')).toBe('document');
  });
});

describe('mimeTypeForPath', () => {
  it('resolves known extensions via EXT_MIME_MAP', () => {
    expect(mimeTypeForPath('/x/a.png')).toBe('image/png');
    expect(mimeTypeForPath('/x/report.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeTypeForPath('/x/data.bin')).toBe('application/octet-stream');
    expect(mimeTypeForPath('/x/noext')).toBe('application/octet-stream');
  });
});
