/**
 * Message utilities for QQ adapter
 */

const MAX_MESSAGE_LENGTH = 4000;

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

export function cleanContent(content: string): string {
  if (!content) return '';
  return content.replace(/<@!\d+>/g, '').trim();
}

export function parseChatType(chatId: string): { chatType: string; targetId: string } | null {
  const parts = chatId.split(':', 2);
  if (parts.length !== 2) return null;
  return { chatType: parts[0], targetId: parts[1] };
}

export function buildChatId(type: 'c2c' | 'group' | 'channel' | 'dm', id: string): string {
  return `${type}:${id}`;
}

export function getMsgType(parseMode?: string): number {
  return parseMode === 'Markdown' ? 2 : 0;
}

export function getMediaQQMsgType(mediaType: string): number {
  switch (mediaType) {
    case 'photo': return 7;
    case 'video': return 4;
    case 'voice': return 8;
    case 'document': return 6;
    default: return 0;
  }
}

export function getMimeType(filePath: string, mediaType: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.oga': 'audio/ogg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4',
    '.amr': 'audio/amr',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
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

export function getMediaFileType(mediaType: string): number {
  switch (mediaType) {
    case 'photo': return 1;
    case 'video': return 2;
    case 'voice': return 3;
    default: return 4;
  }
}