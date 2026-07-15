/**
 * Shared plain-text <-> HTML conversion helpers for editable text elements.
 *
 * Sticky notes and standalone TextElement both use the same editing model:
 * content is stored as a string that may be either plain text (with \n
 * paragraph breaks) or rich HTML. When entering edit mode we normalize the
 * stored value into HTML the contenteditable can render; when leaving edit
 * mode we normalize back so legacy plain-text notes stay plain text.
 *
 * Keeping these helpers in one place prevents the two elements from drifting
 * apart as the conversion logic evolves.
 */

/** True when `value` already looks like HTML (contains a tag). */
export function looksLikeHtml(value: string): boolean {
  return /<[a-z][\s\S]*?>/i.test(value.trim());
}

/**
 * Convert a plain-text / markdown-ish string into simple HTML paragraphs.
 * Inline `**bold**`, `*italic*`, `~~strike~~` markers are translated to
 * `<b>`/`<i>`/`<s>` so legacy markdown notes remain editable as rich text.
 */
export function markdownToHtml(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "<p><br></p>";
  return trimmed
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    .replace(/\*(.+?)\*/g, "<i>$1</i>")
    .replace(/_(.+?)_/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .split("\n")
    .map((line) => (line.trim() ? `<p>${line.replace(/</g, "&lt;")}</p>` : ""))
    .join("");
}

/**
 * Normalize a stored string into HTML for the contenteditable editor.
 * Already-HTML content is passed through; plain text is converted.
 */
export function textToHtml(value: string): string {
  const trimmed = value.trim();
  if (looksLikeHtml(trimmed)) return trimmed;
  return markdownToHtml(trimmed);
}

/**
 * Normalize edited HTML back into a storage string.
 *
 * If the HTML only contains plain paragraphs, strip the tags and save as
 * plain text (so legacy markdown/plain notes stay markdown-compatible).
 * Otherwise keep the rich HTML as-is.
 */
export function htmlToText(html: string): string {
  const trimmed = html.replace(/<p><br><\/p>/gi, "").trim();
  const hasRichTags = /<(?:b|i|u|s|strong|em|span|font|strike|del)[\s>]>/i.test(trimmed);
  if (!hasRichTags) {
    return trimmed
      .replace(/<\/p>\s*<p>/gi, "\n")
      .replace(/<\/?p>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .trim();
  }
  return trimmed;
}
