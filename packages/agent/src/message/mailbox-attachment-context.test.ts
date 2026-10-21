import { describe, expect, it, vi } from 'vitest';
import type { MailboxRow } from '../session/db.js';
import { prepareMailboxGuidance } from './mailbox-attachment-context.js';
import { projectRuntimeContextToProviderMessage } from './runtime-context-adapters.js';

const files = [
  { id: 'a', name: 'image.png', type: 'image/png', url: 'data:image/png;base64,YWJj', size: 3 },
  { id: 'b', name: 'image.png', type: 'image/png', url: 'data:image/png;base64,ZGVm', size: 3 },
  { id: 'c', kind: 'pasted-text', name: 'reference', type: 'text/plain', url: '', text: 'Reference body', size: 14 },
];
const row = (content = '') => ({ id: 'row', content, kind: 'followup', source: 'ui', attachments_json: JSON.stringify(files) }) as MailboxRow;
describe('attachment-aware runtime guidance', () => {
  it('projects image-only guidance with both distinct images and attachment text', async () => {
    const contexts = await prepareMailboxGuidance([row()], ['token'], { imageInputSupported: true });
    const projected = projectRuntimeContextToProviderMessage(contexts[0]);
    expect(contexts[0].visibility).toBe('hidden');
    const content = projected?.content;
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) throw new Error('Expected multimodal content');
    expect(content.filter((block) => block.type === 'image').map((block) => block.type === 'image' ? block.source.data : '')).toEqual(['YWJj', 'ZGVm']);
    expect(JSON.stringify(content)).toContain('Reference body');
  });
  it('uses vision summaries for text-only models and reports analysis failures', async () => {
    const analyzeImage = vi.fn().mockResolvedValueOnce('First image summary').mockRejectedValueOnce(new Error('unavailable'));
    const result = await prepareMailboxGuidance([row('compare')], ['token'], { imageInputSupported: false, analyzeImage });
    expect(analyzeImage).toHaveBeenNthCalledWith(1, 'YWJj', 'image/png', 'compare');
    expect(analyzeImage).toHaveBeenNthCalledWith(2, 'ZGVm', 'image/png', 'compare');
    expect(JSON.stringify(result)).toContain('First image summary');
    expect(JSON.stringify(result)).toContain('could not be analyzed');
    expect(JSON.stringify(result)).not.toContain('"type":"image"');
  });
  it('does not inject an unclaimed row', async () => {
    expect(await prepareMailboxGuidance([row()], [], { imageInputSupported: true })).toEqual([]);
  });
});
