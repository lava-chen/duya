export interface BrowserReferenceDisplayData {
  kind: 'element' | 'screenshot';
  label: string;
  title: string;
  url: string;
  content: string;
}

const BROWSER_REFERENCE_MARKER_REGEX = /\[\[duya-browser-ref:([^\]]+)\]\]/g;

export function serializeBrowserReferenceForDisplay(reference: BrowserReferenceDisplayData): string {
  return `[[duya-browser-ref:${encodeURIComponent(JSON.stringify(reference))}]]`;
}

export function parseBrowserReferenceDisplayContent(content: string): {
  text: string;
  references: BrowserReferenceDisplayData[];
} {
  const references: BrowserReferenceDisplayData[] = [];
  const text = content.replace(BROWSER_REFERENCE_MARKER_REGEX, (_match, encoded) => {
    try {
      const decoded = JSON.parse(decodeURIComponent(encoded)) as BrowserReferenceDisplayData;
      if (
        decoded
        && (decoded.kind === 'element' || decoded.kind === 'screenshot')
        && typeof decoded.label === 'string'
        && typeof decoded.title === 'string'
        && typeof decoded.url === 'string'
        && typeof decoded.content === 'string'
      ) {
        references.push(decoded);
      }
    } catch {
      // Ignore malformed markers and drop them from the rendered text.
    }
    return '';
  });

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    references,
  };
}

function cleanBrowserReferenceLabel(label: string): string {
  return label
    .replace(/\.__duya_browser_pick_hover__/g, '')
    .replace(/\.__duya_[\w-]+__/g, '')
    .replace(/__duya_[\w-]+__/g, '')
    .replace(/\.+$/g, '')
    .trim();
}

export function browserReferenceDisplaySummary(reference: BrowserReferenceDisplayData): string {
  const label = cleanBrowserReferenceLabel(reference.label);
  const headline = reference.kind === 'screenshot'
    ? `Browser screenshot: ${reference.title || reference.label}`
    : `Browser element: ${label || reference.title}`;
  return `${headline}\n${reference.url}`;
}
