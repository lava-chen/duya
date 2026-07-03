const PASTED_CONTENT_START_MARKER = '<pasted-content id="';
const PASTED_CONTENT_END_MARKER = '</pasted-content>';

interface EncodedPastedPayload {
  preview: string;
  full: string;
}

function decodePayloadFromMarker(b64: string): EncodedPastedPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.preview === 'string' &&
      typeof parsed.full === 'string'
    ) {
      return parsed;
    }
  } catch {
    // Treat malformed markers as plain text at the call site.
  }
  return null;
}

export function stripPastedContentMarkers(content: string): string {
  if (!content.includes(PASTED_CONTENT_START_MARKER)) {
    return content;
  }

  let remainingContent = content;
  let result = '';

  while (remainingContent.length > 0) {
    const startIndex = remainingContent.indexOf(PASTED_CONTENT_START_MARKER);
    if (startIndex === -1) {
      result += remainingContent;
      break;
    }

    result += remainingContent.substring(0, startIndex);
    const afterStartMarker = remainingContent.substring(startIndex + PASTED_CONTENT_START_MARKER.length);
    const idEndIndex = afterStartMarker.indexOf('"');
    if (idEndIndex === -1) {
      result += remainingContent.substring(startIndex);
      break;
    }

    const afterId = afterStartMarker.substring(idEndIndex + 1);
    const newFormatMatch = /^ data="([^"]*)"/.exec(afterId);
    if (newFormatMatch) {
      const afterData = afterId.substring(newFormatMatch[0].length);
      const closeMarkerIndex = afterData.indexOf(PASTED_CONTENT_END_MARKER);
      if (closeMarkerIndex === -1) {
        result += remainingContent.substring(startIndex);
        break;
      }

      const decoded = decodePayloadFromMarker(newFormatMatch[1]);
      if (decoded) {
        result += decoded.full;
      }
      remainingContent = afterData.substring(closeMarkerIndex + PASTED_CONTENT_END_MARKER.length);
      continue;
    }

    const legacyPrefixMatch = /^ preview="/.exec(afterId);
    if (legacyPrefixMatch) {
      const afterPreviewStart = afterId.substring(legacyPrefixMatch[0].length);
      const previewEndIndex = afterPreviewStart.indexOf('">');
      if (previewEndIndex === -1) {
        result += remainingContent.substring(startIndex);
        break;
      }
      const afterPreviewEnd = afterPreviewStart.substring(previewEndIndex + '">'.length);
      const contentEndIndex = afterPreviewEnd.indexOf(PASTED_CONTENT_END_MARKER);
      if (contentEndIndex === -1) {
        result += remainingContent.substring(startIndex);
        break;
      }
      result += afterPreviewEnd.substring(0, contentEndIndex);
      remainingContent = afterPreviewEnd.substring(contentEndIndex + PASTED_CONTENT_END_MARKER.length);
      continue;
    }

    result += remainingContent.substring(startIndex);
    break;
  }

  return result.trim();
}
