/**
 * Message utility functions
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

export function getBatchKey(
  platformChatId: string,
  platformUserId: string,
  threadId?: string
): string {
  return `${platformChatId}:${platformUserId}:${threadId ?? 'main'}`;
}

export function mergeCaption(existing?: string, incoming?: string): string | undefined {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return `${existing}\n${incoming}`;
}

export function cleanTriggerText(
  text: string | undefined,
  entities?: Array<{
    type: string;
    offset: number;
    length: number;
  }>,
  botUsername?: string
): string | undefined {
  if (!text || !entities || !botUsername) return text;

  let cleaned = text;
  let offsetAdjust = 0;

  const sortedEntities = [...entities]
    .filter((e) => e.type === 'mention')
    .sort((a, b) => b.offset - a.offset);

  for (const entity of sortedEntities) {
    const mentionText = cleaned.substring(
      entity.offset - offsetAdjust,
      entity.offset - offsetAdjust + entity.length
    );
    if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
      const before = cleaned.slice(0, entity.offset - offsetAdjust);
      const after = cleaned.slice(entity.offset - offsetAdjust + entity.length);
      cleaned = (before + after).trim();
      offsetAdjust += entity.length;
    }
  }

  return cleaned || undefined;
}
