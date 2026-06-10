// message-content-parser.ts - Utilities for parsing message content with pasted content markers

export interface ParsedMessageContent {
  text: string;
  pastedContents: PastedContentInfo[];
}

export interface PastedContentInfo {
  id: string;
  preview: string;
  fullContent: string;
}

const PASTED_CONTENT_START_MARKER = '<pasted-content id="';
const PASTED_CONTENT_END_MARKER = '</pasted-content>';

// To avoid ambiguity with arbitrary text inside pasted payloads (HTML/SVG/XML
// frequently contains `">`, `preview="`, and even the literal `</pasted-content>`
// substring), the inner payload is base64-encoded into a `data` attribute.
// Marker shape (new format):
//   <pasted-content id="<uuid>" data="<base64-json>"></pasted-content>
// where `<base64-json>` decodes to `{"preview":"...","full":"..."}`.
//
// Legacy markers (no `data=` attribute) are still parsed for backward
// compatibility with messages persisted before this change.

interface EncodedPastedPayload {
  preview: string;
  full: string;
}

function encodePayloadForMarker(payload: EncodedPastedPayload): string {
  if (typeof btoa === 'function') {
    // Use unicode-safe base64 encoding so any UTF-8 text round-trips correctly.
    return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  }
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

function decodePayloadFromMarker(b64: string): EncodedPastedPayload | null {
  try {
    const json =
      typeof atob === 'function'
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, 'base64').toString('utf-8');
    const parsed = JSON.parse(json);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.preview === 'string' &&
      typeof parsed.full === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Wrap pasted content with markers for storage and display
 */
export function wrapPastedContent(id: string, preview: string, content: string): string {
  const data = encodePayloadForMarker({ preview, full: content });
  return `<pasted-content id="${id}" data="${data}"></pasted-content>`;
}

/**
 * Parse message content to extract pasted content markers and text
 */
export function parseMessageContentWithPasted(content: string): ParsedMessageContent {
  const pastedContents: PastedContentInfo[] = [];
  let remainingContent = content;
  let result = '';

  while (remainingContent.length > 0) {
    const startIndex = remainingContent.indexOf(PASTED_CONTENT_START_MARKER);

    if (startIndex === -1) {
      result += remainingContent;
      break;
    }

    // Text before the marker is preserved verbatim.
    result += remainingContent.substring(0, startIndex);

    const afterStartMarker = remainingContent.substring(startIndex + PASTED_CONTENT_START_MARKER.length);

    // `id` runs until the next `"` — ids are uuids/hex so they never contain quotes.
    const idEndIndex = afterStartMarker.indexOf('"');
    if (idEndIndex === -1) {
      // Malformed: drop the dangling opener and stop to avoid an infinite loop.
      break;
    }
    const id = afterStartMarker.substring(0, idEndIndex);

    const afterId = afterStartMarker.substring(idEndIndex + 1);

    // Try the new `data="..."` attribute first.
    const newFormatMatch = /^ data="([^"]*)"/.exec(afterId);
    if (newFormatMatch) {
      const dataEndIndex = newFormatMatch[0].length - 1; // index of closing `"`
      const data = newFormatMatch[1];
      const afterData = afterId.substring(dataEndIndex + 1);

      const closeMarkerIndex = afterData.indexOf(PASTED_CONTENT_END_MARKER);
      if (closeMarkerIndex === -1) {
        // Malformed marker — bail out cleanly.
        break;
      }

      const decoded = decodePayloadFromMarker(data);
      if (decoded) {
        pastedContents.push({
          id,
          preview: decoded.preview,
          fullContent: decoded.full,
        });
      }

      remainingContent = afterData.substring(closeMarkerIndex + PASTED_CONTENT_END_MARKER.length);
      continue;
    }

    // Legacy format: ` preview="<escaped preview>">FULL_CONTENT</pasted-content>`
    const legacyPrefixMatch = /^ preview="/.exec(afterId);
    if (legacyPrefixMatch) {
      const afterPreviewStart = afterId.substring(legacyPrefixMatch[0].length);
      const previewEndIndex = afterPreviewStart.indexOf('">');
      if (previewEndIndex === -1) {
        break;
      }
      const preview = afterPreviewStart.substring(0, previewEndIndex).replace(/&quot;/g, '"');
      const afterPreviewEnd = afterPreviewStart.substring(previewEndIndex + '">'.length);
      const contentEndIndex = afterPreviewEnd.indexOf(PASTED_CONTENT_END_MARKER);
      if (contentEndIndex === -1) {
        break;
      }
      const fullContent = afterPreviewEnd.substring(0, contentEndIndex);
      pastedContents.push({
        id,
        preview,
        fullContent,
      });
      remainingContent = afterPreviewEnd.substring(contentEndIndex + PASTED_CONTENT_END_MARKER.length);
      continue;
    }

    // Unknown attribute shape — treat the rest of the input as plain text.
    result += remainingContent.substring(startIndex);
    break;
  }

  return {
    text: result.trim(),
    pastedContents,
  };
}

/**
 * Check if message content contains pasted content markers
 */
export function hasPastedContentMarkers(content: string): boolean {
  return content.includes(PASTED_CONTENT_START_MARKER);
}

/**
 * Strip pasted content markers from message content, returning plain text
 * Replaces markers with the actual pasted content, preserving surrounding text
 */
export function stripPastedContentMarkers(content: string): string {
  const parsed = parseMessageContentWithPasted(content);
  const parts: string[] = [];

  if (parsed.text) {
    parts.push(parsed.text);
  }

  for (const pasted of parsed.pastedContents) {
    parts.push(pasted.fullContent);
  }

  return parts.join('\n\n');
}