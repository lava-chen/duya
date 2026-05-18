/**
 * Message utilities for WhatsApp adapter
 */

const MAX_MESSAGE_LENGTH = 4096;

export function splitMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function extractMessageId(result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as { id?: { _serialized?: string }; _serialized?: string };
    return r.id?._serialized ?? r._serialized ?? '';
  }
  return '';
}

export function getExtensionFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'video/mp4': '.mp4',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
  };
  return map[mimeType] || '.bin';
}

export function getMimeType(filePath: string, mediaType: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
  };

  if (mimeMap[ext]) return mimeMap[ext];

  switch (mediaType) {
    case 'photo': return 'image/jpeg';
    case 'voice': return 'audio/ogg';
    case 'video': return 'video/mp4';
    default: return 'application/octet-stream';
  }
}

export function getMediaCategory(mimeType: string): 'image' | 'voice' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/') || mimeType.includes('ogg')) return 'voice';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Convert standard markdown to WhatsApp-compatible formatting.
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```
 */
export function formatMessageForWhatsApp(content: string): string {
  if (!content) return content;

  const fences: string[] = [];
  const FENCE_PH = '\x00FENCE';

  function saveFence(match: string): string {
    fences.push(match);
    return `${FENCE_PH}${fences.length - 1}\x00`;
  }

  let result = content.replace(/```[\s\S]*?```/g, saveFence);

  const codes: string[] = [];
  const CODE_PH = '\x00CODE';

  function saveCode(match: string): string {
    codes.push(match);
    return `${CODE_PH}${codes.length - 1}\x00`;
  }

  result = result.replace(/`[^`\n]+`/g, saveCode);

  result = result.replace(/\*\*(.+?)\*\*/g, '*$1*');
  result = result.replace(/__(.+?)__/g, '*$1*');
  result = result.replace(/~~(.+?)~~/g, '~$1~');
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  for (let i = 0; i < fences.length; i++) {
    result = result.replace(`${FENCE_PH}${i}\x00`, fences[i]);
  }
  for (let i = 0; i < codes.length; i++) {
    result = result.replace(`${CODE_PH}${i}\x00`, codes[i]);
  }

  return result;
}