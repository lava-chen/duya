/**
 * Message utilities for WeChat adapter
 */

const MAX_MESSAGE_LENGTH = 2048;

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

export function parseMessageContent(msg: {
  Content?: string;
  StrContent?: string;
  item_list?: Array<{ type: number; text_item?: { text: string } }>;
}): string {
  // Support new API format with item_list
  if (msg.item_list && msg.item_list.length > 0) {
    for (const item of msg.item_list) {
      if (item.type === 1 && item.text_item?.text) {
        return item.text_item.text;
      }
    }
  }
  // Fall back to old format
  return msg.Content ?? msg.StrContent ?? '';
}

export function getMediaType(msgType: number): 'text' | 'image' | 'voice' | 'video' {
  switch (msgType) {
    case 1: return 'text';
    case 3: return 'image';
    case 34: return 'voice';
    case 43:
    case 62: return 'video';
    default: return 'text';
  }
}

export function isFromGroup(toUserName: string): boolean {
  // New format: group IDs typically contain '@chatroom' suffix
  if (toUserName.includes('@chatroom') || toUserName.includes('@im.group')) {
    return true;
  }
  // Old format: group IDs start with @@
  return toUserName.startsWith('@@');
}

export function isFromUser(toUserName: string): boolean {
  return !toUserName.startsWith('@@');
}