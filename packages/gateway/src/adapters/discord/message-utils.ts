/**
 * Message utilities for Discord adapter
 */

const MAX_MESSAGE_LENGTH = 2000;

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
  return content.replace(/<@!?\d+>/g, '').trim();
}

export function isDirectMessage(channelType: number): boolean {
  return channelType === 1; // DM channel type
}

export function isGroupDM(channelType: number): boolean {
  return channelType === 3; // Group DM channel type
}

export function isGuildChannel(channelType: number): boolean {
  return channelType >= 0 && channelType <= 15 && channelType !== 1 && channelType !== 3;
}

export function isThread(channelType: number): boolean {
  return channelType === 11 || channelType === 12;
}

export function getMimeType(filePath: string): string {
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
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
  };

  return mimeMap[ext] || 'application/octet-stream';
}