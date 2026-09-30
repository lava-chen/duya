import type { FileAttachment, MessageContent } from '../types.js';
import type { MailboxRow } from '../session/db.js';
import { buildAttachmentContext, persistLargePastedAttachments } from '../utils/attachment-context.js';
import { imageContentBlock, loadAttachmentImages, parseMailboxAttachments } from '../utils/attachment-images.js';
import { adaptMailboxRows, type RuntimeContextAdapterOptions } from './runtime-context-adapters.js';
import type { RuntimeContextMessage } from './message-framework.js';

export async function prepareMailboxGuidance(
  rows: readonly MailboxRow[],
  tokens: readonly string[],
  options: RuntimeContextAdapterOptions & {
    imageInputSupported: boolean;
    analyzeImage?: (base64: string, mediaType: string, prompt?: string) => Promise<string>;
  },
): Promise<RuntimeContextMessage[]> {
  const contexts: RuntimeContextMessage[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!tokens[index]) continue;
    const context = adaptMailboxRows([row], [tokens[index]], options)[0];
    if (!context) continue;
    const files: FileAttachment[] = await persistLargePastedAttachments(parseMailboxAttachments(row.attachments_json));
    const text = buildAttachmentContext(files);
    const content: MessageContent[] = [{ type: 'text', text: String(context.content) + (text ? '\n\n' + text : '') }];
    const images = await loadAttachmentImages(files);
    for (const [file, image] of images) {
      if (options.imageInputSupported) content.push(imageContentBlock(image));
      else if (options.analyzeImage) {
        try {
          const analysis = await options.analyzeImage(image.base64, image.mediaType, row.content);
          content.push({ type: 'text', text: `[Image: "${file.name}"]\n${analysis}` });
        } catch {
          content.push({ type: 'text', text: `[Image "${file.name}" could not be analyzed. Do not infer its contents.]` });
        }
      } else content.push({ type: 'text', text: `[Image "${file.name}" requires a vision model to read its contents.]` });
    }
    if (options.imageInputSupported) {
      for (const file of files) for (const image of file.imageChunks ?? []) content.push(imageContentBlock(image));
    }
    contexts.push({ ...context, content: files.length ? content : context.content });
  }
  return contexts;
}
