import { describe, expect, it } from 'vitest';
import { loadAttachmentImages, parseMailboxAttachments } from './attachment-images.js';
import type { FileAttachment } from '../types.js';

const image = (id: string, data: string): FileAttachment => ({ id, name: 'image.png', type: 'image/png', url: `data:image/png;base64,${data}`, size: 3 });
describe('attachment image identity', () => {
  it('preserves different images with the same filename and legacy ID', async () => {
    const first = image('same-id', 'YWJj');
    const second = image('same-id', 'ZGVm');
    const result = await loadAttachmentImages([first, second]);
    expect(result.size).toBe(2);
    expect(result.get(first)?.base64).toBe('YWJj');
    expect(result.get(second)?.base64).toBe('ZGVm');
  });
  it('uses the data URL MIME type and skips unavailable images individually', async () => {
    const first = { ...image('a', 'YWJj'), type: 'image/jpeg' };
    const missing = { ...image('b', 'ZGVm'), url: 'https://example.com/image.png' };
    const result = await loadAttachmentImages([first, missing]);
    expect(result.get(first)?.mediaType).toBe('image/png');
    expect(result.has(missing)).toBe(false);
  });
  it('rejects malformed attachment rows without losing valid ones', () => {
    expect(parseMailboxAttachments('{')).toEqual([]);
    expect(parseMailboxAttachments(JSON.stringify([null, {}, image('a', 'YWJj')]))).toHaveLength(1);
  });
});
