/**
 * channel-delivery.test.ts — multipart builder + Telegram media routing
 * (plan 507 P3.2/P3.3). The helper functions under test are pure, but the
 * module's import chain resolves `connector-secret-store` (electron app),
 * so `electron` is mocked to a temp userData before import.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-delivery-test-'));

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

vi.mock('electron', () => ({
  app: { getPath: () => userData },
}));

import {
  buildMultipartBody,
  telegramMediaSend,
} from '../channel-delivery';

describe('buildMultipartBody', () => {
  it('wraps a file part in a well-formed multipart buffer with boundary and filename', () => {
    const payload = Buffer.from('fake-png-bytes');
    const { body, contentType } = buildMultipartBody(
      { caption: 'hello' },
      { name: 'photo', filename: 'shot.png', contentType: 'image/png', bytes: payload },
    );

    expect(Buffer.isBuffer(body)).toBe(true);
    // Content-Type carries the boundary used throughout the body.
    const boundary = contentType.match(/boundary=(.+)$/)?.[1];
    expect(boundary).toBeDefined();

    const text = body.toString('utf8');
    expect(text).toContain(`--${boundary}`);
    // Field + file part headers and the raw content are all present.
    expect(text).toMatch(/Content-Disposition: form-data; name="caption"/);
    expect(text).toMatch(/Content-Disposition: form-data; name="photo"; filename="shot.png"/);
    expect(text).toContain('Content-Type: image/png');
    expect(text).toContain('fake-png-bytes');
    // Ends with the closing boundary.
    expect(body.subarray(body.length - `--${boundary}--\r\n`.length).toString('utf8')).toBe(`--${boundary}--\r\n`);
  });

  it('produces the byte content verbatim (not twice-encoded)', () => {
    const payload = Buffer.from([0x00, 0xff, 0x10]);
    const { body } = buildMultipartBody(
      {},
      { name: 'document', filename: 'bin.dat', contentType: 'application/octet-stream', bytes: payload },
    );
    // The raw bytes must survive as-is inside the body.
    const idx = body.indexOf(payload);
    expect(idx).toBeGreaterThan(-1);
    expect(body.slice(idx, idx + payload.length)).toEqual(payload);
  });
});

describe('telegramMediaSend (media-kind → endpoint / file field)', () => {
  it('routes image to sendPhoto with a photo file part', () => {
    expect(telegramMediaSend('photo')).toEqual({ endpoint: 'sendPhoto', fileField: 'photo' });
  });

  it('routes video to sendVideo with a video file part', () => {
    expect(telegramMediaSend('video')).toEqual({ endpoint: 'sendVideo', fileField: 'video' });
  });

  it('routes audio/voice to sendAudio with an audio file part', () => {
    expect(telegramMediaSend('voice')).toEqual({ endpoint: 'sendAudio', fileField: 'audio' });
  });

  it('routes everything else to sendDocument with a document file part', () => {
    expect(telegramMediaSend('document')).toEqual({ endpoint: 'sendDocument', fileField: 'document' });
  });
});