import type { FeishuMessageContent, FeishuPostParagraph, FeishuMention, FeishuRichText } from './types';

const MAX_MESSAGE_LENGTH = 4000;

export function splitMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(' ', maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function parseMessageContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.text) return parsed.text;
      if (parsed.content) return parsed.content;
      return JSON.stringify(parsed);
    }
    return String(parsed);
  } catch {
    return content;
  }
}

export function extractTextFromMessage(body: { content: string }): string {
  return parseMessageContent(body.content);
}

export function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export function parseFeishuContent(content: string): FeishuMessageContent | null {
  try { return JSON.parse(content) as FeishuMessageContent; } catch { return null; }
}

export function extractPlainTextFromPost(post: FeishuPostParagraph[][]): string {
  const parts: string[] = [];
  for (const line of post) {
    const lineParts: string[] = [];
    for (const para of line) {
      switch (para.tag) {
        case 'text': lineParts.push(para.text || ''); break;
        case 'a': lineParts.push(para.href ? `[${para.text || ''}](${para.href})` : (para.text || '')); break;
        case 'at': lineParts.push(`@${para.user_name || para.user_id || 'unknown'}`); break;
        case 'img': lineParts.push('[image]'); break;
        case 'media': lineParts.push('[media]'); break;
        case 'emotion': lineParts.push(para.emoji_type || '[emoji]'); break;
        case 'hr': lineParts.push('\n---\n'); break;
        case 'code_block': lineParts.push(para.language ? `\`\`\`${para.language}\n${para.text || ''}\n\`\`\`` : `\`\`\`\n${para.text || ''}\n\`\`\``); break;
        case 'md': lineParts.push(para.text || ''); break;
        default: lineParts.push(para.text || '');
      }
    }
    parts.push(lineParts.join(''));
  }
  return parts.join('\n');
}

export function extractMentionsFromMessage(content: FeishuMessageContent, topLevelMentions?: FeishuMention[]): FeishuMention[] {
  const result: FeishuMention[] = [];
  if (topLevelMentions && topLevelMentions.length > 0) result.push(...topLevelMentions);
  if (content.elements) {
    for (const el of content.elements) {
      if (el.tag === 'at') {
        const key = el.user_id || el.open_id || el.at_user_id || '';
        if (key && !result.some(m => m.key === key)) {
          result.push({ key, id: { open_id: el.open_id, user_id: el.user_id || el.at_user_id }, name: el.text || key, tenant_key: '' });
        }
      }
    }
  }
  return result;
}

export function extractRichText(content: FeishuMessageContent, mentions?: FeishuMention[]): FeishuRichText {
  const mentionMap = new Map<string, string>();
  if (mentions) {
    for (const m of mentions) { mentionMap.set(m.key, `@${m.name}`); }
  }

  let raw = '';
  let plainContent = '';

  if (content.elements) {
    const parts: string[] = [];
    for (const el of content.elements) {
      switch (el.tag) {
        case 'text': raw += el.text || ''; parts.push(el.text || ''); break;
        case 'at': {
          const key = el.user_id || el.open_id || el.at_user_id || '';
          const resolved = mentionMap.get(key) || `@${el.text || key}`;
          raw += ` ${resolved} `; parts.push(` ${resolved} `); break;
        }
        case 'a': raw += el.url || el.text || ''; parts.push(el.url || el.text || ''); break;
        case 'img': raw += '[image]'; parts.push('[image]'); break;
        case 'media': raw += '[media]'; parts.push('[media]'); break;
        default: raw += el.text || ''; parts.push(el.text || '');
      }
    }
    plainContent = parts.join('');
  }

  if (content.post) {
    const post = content.post.zh_cn || content.post.en_us || content.post.ja_jp;
    if (post) { raw = extractPlainTextFromPost(post.content || []); plainContent = raw; }
  }

  if (!raw && content.text) { raw = content.text; plainContent = content.text; }

  return { raw: raw || '[empty message]', content: plainContent || raw || '[empty message]', mentions: mentions || [] };
}

export function splitLongTextContent(text: string, maxChunks: number = 10): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  return splitMessage(text, MAX_MESSAGE_LENGTH).slice(0, maxChunks);
}

export function truncateDisplay(text: string, maxLen: number = 80): string {
  if (text.length <= maxLen) return text.replace(/\n/g, '\\n');
  return text.slice(0, maxLen).replace(/\n/g, '\\n') + '...';
}

export function isFeishuAudioFile(ext: string): boolean {
  const audioExts = new Set(['.ogg', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.opus', '.wma', '.amr']);
  return audioExts.has(ext.toLowerCase());
}

export function isFeishuImageFile(ext: string): boolean {
  const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.svg']);
  return imageExts.has(ext.toLowerCase());
}

export function parseFileNameFromMessage(content: FeishuMessageContent): string {
  if (content.elements) {
    for (const el of content.elements) {
      if (el.tag === 'file' && el.text) return el.text;
    }
  }
  return 'unknown_file';
}

export function isBotMentioned(botOpenId: string, content: FeishuMessageContent, mentions?: FeishuMention[]): boolean {
  if (mentions) {
    for (const m of mentions) {
      if (m.id?.open_id === botOpenId) return true;
    }
  }
  if (content.elements) {
    for (const el of content.elements) {
      if (el.tag === 'at') {
        const id = el.user_id || el.open_id || el.at_user_id || '';
        if (id === botOpenId) return true;
      }
    }
  }
  return false;
}