import type { Message } from '@/types/message';

export interface BrowserSource {
  url: string;
  title: string;
  hostname: string;
  timestamp: number;
}

function parseHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function extractTitleFromResult(content: string): string | null {
  const match = content.match(/^- Title: (.+)$/m);
  if (match) return match[1].trim();
  const parallelMatch = content.match(/\*\*Title\*\*: ([^\n|]+)/);
  if (parallelMatch) return parallelMatch[1].trim();
  return null;
}

export function extractBrowserSources(messages: Message[]): BrowserSource[] {
  const byUrl = new Map<string, BrowserSource>();
  const resultByToolCallId = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id && typeof msg.content === 'string') {
      resultByToolCallId.set(msg.tool_call_id, msg.content);
    }
  }

  for (const msg of messages) {
    if (msg.msgType !== 'tool_use' || msg.toolName !== 'browser' || !msg.toolInput) continue;

    let input: unknown;
    try {
      input = JSON.parse(msg.toolInput);
    } catch {
      continue;
    }
    if (!input || typeof input !== 'object') continue;

    const operation = (input as Record<string, unknown>).operation;
    const urls: string[] = [];

    if (operation === 'navigate') {
      const url = (input as Record<string, unknown>).url;
      if (typeof url === 'string' && url.trim()) urls.push(url.trim());
    } else if (operation === 'parallel_fetch') {
      const rawUrls = (input as Record<string, unknown>).urls;
      if (Array.isArray(rawUrls)) {
        for (const u of rawUrls) {
          if (typeof u === 'string' && u.trim()) urls.push(u.trim());
        }
      }
    }

    if (urls.length === 0) continue;

    const resultContent = msg.tool_call_id ? resultByToolCallId.get(msg.tool_call_id) : undefined;
    const parsedTitle = resultContent ? extractTitleFromResult(resultContent) : null;

    for (const url of urls) {
      const title = parsedTitle || parseHostname(url);
      const existing = byUrl.get(url);
      const timestamp = msg.timestamp || 0;
      if (!existing || timestamp > existing.timestamp) {
        byUrl.set(url, {
          url,
          title,
          hostname: parseHostname(url),
          timestamp,
        });
      }
    }
  }

  return Array.from(byUrl.values()).sort((a, b) => b.timestamp - a.timestamp);
}
