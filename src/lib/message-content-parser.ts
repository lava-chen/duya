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
const PASTED_CONTENT_PREVIEW_START = '" preview="';
const PASTED_CONTENT_PREVIEW_END = '">';
const PASTED_CONTENT_END_MARKER = '</pasted-content>';

/**
 * Wrap pasted content with markers for storage and display
 */
export function wrapPastedContent(id: string, preview: string, content: string): string {
  // Escape quotes in preview to avoid breaking the marker format
  const escapedPreview = preview.replace(/"/g, '&quot;');
  return `${PASTED_CONTENT_START_MARKER}${id}${PASTED_CONTENT_PREVIEW_START}${escapedPreview}${PASTED_CONTENT_PREVIEW_END}${content}${PASTED_CONTENT_END_MARKER}`;
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
      // No more pasted content markers
      result += remainingContent;
      break;
    }

    // Add text before the marker
    result += remainingContent.substring(0, startIndex);

    // Find the end of the marker and extract pasted content info
    const afterStartMarker = remainingContent.substring(startIndex + PASTED_CONTENT_START_MARKER.length);
    const idEndIndex = afterStartMarker.indexOf(PASTED_CONTENT_PREVIEW_START);

    if (idEndIndex === -1) {
      // Malformed marker, treat as regular text
      result += remainingContent.substring(startIndex, startIndex + PASTED_CONTENT_START_MARKER.length);
      remainingContent = afterStartMarker;
      continue;
    }

    const id = afterStartMarker.substring(0, idEndIndex);
    const afterPreviewStart = afterStartMarker.substring(idEndIndex + PASTED_CONTENT_PREVIEW_START.length);
    const previewEndIndex = afterPreviewStart.indexOf(PASTED_CONTENT_PREVIEW_END);

    if (previewEndIndex === -1) {
      // Malformed marker, treat as regular text
      result += remainingContent.substring(startIndex, startIndex + PASTED_CONTENT_START_MARKER.length + idEndIndex + PASTED_CONTENT_PREVIEW_START.length);
      remainingContent = afterPreviewStart;
      continue;
    }

    const preview = afterPreviewStart.substring(0, previewEndIndex).replace(/&quot;/g, '"');
    const afterPreviewEnd = afterPreviewStart.substring(previewEndIndex + PASTED_CONTENT_PREVIEW_END.length);
    const contentEndIndex = afterPreviewEnd.indexOf(PASTED_CONTENT_END_MARKER);

    if (contentEndIndex === -1) {
      // Malformed marker, treat as regular text
      result += remainingContent.substring(startIndex, startIndex + PASTED_CONTENT_START_MARKER.length + idEndIndex + PASTED_CONTENT_PREVIEW_START.length + previewEndIndex + PASTED_CONTENT_PREVIEW_END.length);
      remainingContent = afterPreviewEnd;
      continue;
    }

    const fullContent = afterPreviewEnd.substring(0, contentEndIndex);

    pastedContents.push({
      id,
      preview,
      fullContent,
    });

    // Continue with remaining content
    remainingContent = afterPreviewEnd.substring(contentEndIndex + PASTED_CONTENT_END_MARKER.length);
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
 */
export function stripPastedContentMarkers(content: string): string {
  const parsed = parseMessageContentWithPasted(content);
  return parsed.text;
}
