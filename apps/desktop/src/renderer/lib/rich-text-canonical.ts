/**
 * Canonical-text helpers for the composer's contentEditable editor.
 *
 * The editor renders atomic inline chips (plugin @-mentions, skill tokens)
 * whose DOM text is the *display* label, which can differ from the text the
 * React value holds — a plugin mention chip shows the plugin's display name
 * but the value carries the bare `@<pluginId>` token. Everything that reads
 * or writes the editor as plain text (value extraction, caret offsets) must
 * go through these helpers so a chip counts as its canonical token rather
 * than its visible label.
 *
 * Canonical tokens:
 *   - plugin mention chip  → `dataset.mentionToken` (e.g. `@wechat-pay`)
 *   - skill chip           → `/` + `dataset.skillChip`
 *   - anything else        → its own `textContent`
 */

/** Font stack shared with fenced code blocks in the markdown renderer. */
export const CODE_FONT_FAMILY =
  "'Fira Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Marks an atomic plugin-@-mention chip; value is the plugin id. */
export const PLUGIN_MENTION_ATTR = 'pluginMention';
/** Canonical token carried by a plugin-@-mention chip (includes leading `@`). */
export const MENTION_TOKEN_ATTR = 'mentionToken';
/** Marks the legacy skill chip; value is the bare skill name. */
export const SKILL_CHIP_ATTR = 'skillChip';

/** Canonical replacement text for an atomic chip element, or null if not a chip. */
export function chipCanonicalToken(el: HTMLElement): string | null {
  if (el.dataset.pluginMention !== undefined) {
    return el.dataset.mentionToken ?? '';
  }
  if (el.dataset.skillChip !== undefined) {
    return `/${el.dataset.skillChip}`;
  }
  return null;
}

/**
 * Plain text of an editable root, with every chip replaced by its canonical
 * token. This is the authoritative value the composer should hold.
 */
export function readCanonicalText(root: HTMLElement): string {
  let out = '';
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      continue;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const token = chipCanonicalToken(el);
      out += token !== null ? token : el.textContent ?? '';
    }
  }
  return out;
}

/**
 * Canonical character offset of a DOM caret position. Cloning the range up to
 * the caret and measuring the detached fragment keeps every chip whole, so a
 * caret sitting inside a chip still maps to that chip's canonical boundary.
 */
export function canonicalOffsetAt(
  root: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  if (!root.contains(container)) return null;
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  const holder = document.createElement('div');
  holder.appendChild(range.cloneContents());
  return readCanonicalText(holder).length;
}

/** Canonical offset of the current selection, or null when it is outside `root`. */
export function getCanonicalCaretOffset(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.endContainer)) return null;
  return canonicalOffsetAt(root, range.endContainer, range.endOffset);
}

/**
 * Place the caret at a canonical offset, treating chips as indivisible units.
 * An offset landing inside a chip snaps to just before/after that chip.
 */
export function setCanonicalCaret(root: HTMLElement, offset: number): void {
  const range = document.createRange();
  let remaining = Math.max(0, offset);
  let placed = false;

  const visit = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        placed = true;
        return true;
      }
      remaining -= length;
      return false;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;

    const el = node as HTMLElement;
    const token = chipCanonicalToken(el);
    if (token !== null) {
      if (remaining <= 0) range.setStartBefore(el);
      else range.setStartAfter(el);
      placed = true;
      return true;
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };

  for (const child of Array.from(root.childNodes)) {
    if (visit(child)) break;
  }
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.collapse(true);
  }

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
