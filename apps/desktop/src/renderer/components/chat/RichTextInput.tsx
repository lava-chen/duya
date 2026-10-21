// RichTextInput.tsx - Plan 220 Phase 4.
//
// ContentEditable input that handles slash-command highlighting and atomic
// inline mention chips. Attachment chips were lifted to <AttachmentBar> above
// the editor in Plan 220, but two kinds of inline token still live in the text
// stream:
//
//   - Skill slash commands (`/docx`, `/commit`) render as a blue bold inline
//     chip with a leading cube icon, but only when the input value is exactly
//     `/<skill-name>` (with optional trailing whitespace).
//   - Plugin @-mentions (`@wechat-pay`) render as an icon + name chip wherever
//     they appear. The chip shows the plugin display name while the value
//     carries the bare `@<pluginId>` token; see rich-text-canonical.ts.
//
// Both chips are `contentEditable=false` atomic nodes: the caret cannot land
// inside them, and Backspace/Delete removes the whole chip in one keystroke.

'use client';

import React, { useRef, useEffect, useCallback } from 'react';
import { forwardRef } from 'react';
import {
  parseSlashCommand,
  parseSkillToken,
  findPluginMentionSpans,
  type PluginMentionTarget,
} from '@/lib/message-input-logic';
import {
  PLUGIN_MENTION_ATTR,
  MENTION_TOKEN_ATTR,
  SKILL_CHIP_ATTR,
  chipCanonicalToken,
  getCanonicalCaretOffset,
  readCanonicalText,
  setCanonicalCaret,
} from '@/lib/rich-text-canonical';
// Chip look (styles + glyph) lives in one module so the composer chip and the
// sent-bubble chip cannot drift apart.
import {
  MENTION_CHIP_STYLE,
  MENTION_ICON_STYLE,
  MENTION_LABEL_STYLE,
  PLUG_GLYPH_PATHS,
} from './PluginMentionChip';

interface RichTextInputProps {
  value: string;
  onChange: (val: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Installed plugins that a bare `@token` in the text resolves to. */
  mentionTargets?: readonly PluginMentionTarget[];
}

function dispatchOpenSkillPreview(skillName: string): void {
  window.dispatchEvent(new CustomEvent('duya:open-skill-preview', {
    detail: { skillName },
  }));
}

/** Generic plug glyph, used when a plugin declares no icon (or it fails). */
function createPlugGlyph(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.flexShrink = '0';
  for (const d of PLUG_GLYPH_PATHS) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function createSkillChip(skillName: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'inline-flex items-center gap-1';
  chip.style.color = '#3b82f6';
  chip.style.fontWeight = '700';
  chip.style.cursor = 'pointer';
  chip.style.userSelect = 'none';
  // Treat the selected skill as one inline control rather than editable text.
  // Backspace/Delete handling below removes this entire node at once.
  chip.contentEditable = 'false';
  chip.dataset[SKILL_CHIP_ATTR] = skillName;
  chip.title = `Open ${skillName} skill source`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 256 256');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'currentColor');
  svg.style.flexShrink = '0';
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M223.7 73.4l-88-48a8.3 8.3 0 0 0-7.4 0l-88 48A8.1 8.1 0 0 0 36 80.2v95.6a8.1 8.1 0 0 0 4.3 7.2l88 48a8.3 8.3 0 0 0 7.4 0l88-48a8.1 8.1 0 0 0 4.3-7.2V80.2a8.1 8.1 0 0 0-4.3-6.8zM128 121.8 47.5 78 128 34.1 208.5 78z');
  svg.appendChild(path);
  chip.appendChild(svg);

  const label = document.createElement('span');
  label.textContent = skillName;
  chip.appendChild(label);

  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dispatchOpenSkillPreview(skillName);
  });
  return chip;
}

/**
 * Atomic plugin mention chip: brand icon + display name (blue, code font).
 * The canonical `@<pluginId>` token is stashed on the node so the composer
 * value round-trips exactly; the visible label is the friendly plugin name.
 */
function createMentionChip(target: PluginMentionTarget, token: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.contentEditable = 'false';
  chip.dataset[PLUGIN_MENTION_ATTR] = target.pluginId;
  chip.dataset[MENTION_TOKEN_ATTR] = token;
  chip.title = target.name;
  Object.assign(chip.style, MENTION_CHIP_STYLE);
  // Composer-only: a non-selectable chip keeps the caret from being parked
  // inside it. In a sent bubble the name stays selectable/copyable.
  chip.style.userSelect = 'none';

  if (target.iconUrl) {
    const img = document.createElement('img');
    img.src = target.iconUrl;
    img.alt = '';
    Object.assign(img.style, MENTION_ICON_STYLE);
    img.addEventListener('error', () => img.replaceWith(createPlugGlyph()));
    chip.appendChild(img);
  } else {
    chip.appendChild(createPlugGlyph());
  }

  const label = document.createElement('span');
  label.textContent = target.name;
  Object.assign(label.style, MENTION_LABEL_STYLE);
  chip.appendChild(label);

  // Keep the caret out of the chip: swallowing mousedown leaves the current
  // selection untouched instead of dropping a caret inside the atomic token.
  chip.addEventListener('mousedown', (e) => e.preventDefault());
  return chip;
}

/**
 * Append `text`, replacing each resolvable `@plugin` token with an atomic
 * mention chip. Unresolved `@tokens` stay as plain text.
 */
function appendTextWithMentions(
  el: HTMLElement,
  text: string,
  targets: readonly PluginMentionTarget[],
): void {
  const spans = findPluginMentionSpans(text, targets);
  if (spans.length === 0) {
    if (text) el.appendChild(document.createTextNode(text));
    return;
  }
  const byId = new Map(targets.map((t) => [t.pluginId, t]));
  let cursor = 0;
  for (const span of spans) {
    const target = byId.get(span.pluginId);
    if (!target) continue;
    if (span.start > cursor) {
      el.appendChild(document.createTextNode(text.slice(cursor, span.start)));
    }
    el.appendChild(createMentionChip(target, span.token));
    cursor = span.end;
  }
  if (cursor < text.length) {
    el.appendChild(document.createTextNode(text.slice(cursor)));
  }
}

/** Nearest chip (skill token or plugin mention) touching a collapsed caret. */
function getAdjacentChip(
  editor: HTMLDivElement,
  direction: 'backward' | 'forward',
): HTMLElement | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.endContainer)) return null;

  let sibling: ChildNode | null = null;
  if (range.endContainer === editor) {
    sibling = direction === 'backward'
      ? editor.childNodes[range.endOffset - 1] ?? null
      : editor.childNodes[range.endOffset] ?? null;
  } else if (range.endContainer.nodeType === Node.TEXT_NODE) {
    const text = range.endContainer.textContent ?? '';
    if (direction === 'backward' && range.endOffset === 0) {
      sibling = range.endContainer.previousSibling;
    } else if (direction === 'forward' && range.endOffset === text.length) {
      sibling = range.endContainer.nextSibling;
    }
  }

  return sibling instanceof HTMLElement && chipCanonicalToken(sibling) !== null
    ? sibling
    : null;
}

export const RichTextInput = forwardRef<HTMLDivElement, RichTextInputProps>(
  ({
    value,
    onChange,
    onKeyDown,
    onPaste,
    placeholder,
    disabled,
    mentionTargets,
  }, ref) => {
    const innerRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);
    // null forces the first build even when the initial value is non-empty
    // (restored draft), so any mention token is chipped on mount.
    const lastValue = useRef<string | null>(null);
    // Read through a ref so buildContent stays stable across target refreshes.
    const targetsRef = useRef<readonly PluginMentionTarget[]>(mentionTargets ?? []);
    targetsRef.current = mentionTargets ?? [];

    // Sync forwarded ref
    useEffect(() => {
      if (typeof ref === 'function') {
        ref(innerRef.current);
      } else if (ref) {
        ref.current = innerRef.current;
      }
    }, [ref]);

    // Build content with optional slash-command highlight span or skill chip.
    const buildContent = useCallback((el: HTMLDivElement, text: string) => {
      const skillToken = parseSkillToken(text);
      el.innerHTML = '';

      if (skillToken) {
        const chip = createSkillChip(skillToken.skillName);
        el.appendChild(chip);
        const trailing = text.slice(text.trim().length);
        if (trailing) {
          el.appendChild(document.createTextNode(trailing));
        }
      } else {
        const slashParsed = parseSlashCommand(text);
        if (slashParsed) {
          const { slashCommand, remainingText } = slashParsed;
          const slashSpan = document.createElement('span');
          slashSpan.dataset.slashCommand = 'true';
          slashSpan.textContent = slashCommand;
          slashSpan.style.color = 'var(--accent)';
          el.appendChild(slashSpan);
          if (remainingText) {
            el.appendChild(document.createTextNode(' '));
            appendTextWithMentions(el, remainingText, targetsRef.current);
          }
        } else {
          appendTextWithMentions(el, text, targetsRef.current);
        }
      }

      // Keep the caret at the end after external rebuilds, but never steal a
      // selection while the editor is unfocused (e.g. a background refresh).
      if (document.activeElement === el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }, []);

    // Update content when value changes externally.
    useEffect(() => {
      const el = innerRef.current;
      if (!el || isComposing.current) return;
      if (value !== lastValue.current) {
        lastValue.current = value;
        buildContent(el, value);
      }
    }, [value, buildContent]);

    // Re-render once the plugin list arrives, so mentions already typed (or
    // waiting on an async refresh) upgrade to chips without losing the caret.
    useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      const text = lastValue.current;
      if (!text || !text.includes('@')) return;
      if (findPluginMentionSpans(text, targetsRef.current).length === 0) return;
      const caret = getCanonicalCaretOffset(el);
      buildContent(el, text);
      if (caret !== null) setCanonicalCaret(el, caret);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mentionTargets]);

    const handleInput = useCallback(() => {
      const el = innerRef.current;
      if (!el || isComposing.current) return;
      const text = readCanonicalText(el);
      lastValue.current = text;
      onChange(text);
      // Re-highlight on subsequent typing when slash command active.
      if (parseSlashCommand(text)) {
        buildContent(el, text);
      }
    }, [buildContent, onChange]);

    const removeAdjacentChip = useCallback((direction: 'backward' | 'forward'): boolean => {
      const el = innerRef.current;
      if (!el) return false;
      const chip = getAdjacentChip(el, direction);
      if (!chip) return false;

      const parent = chip.parentNode;
      const index = parent
        ? Array.prototype.indexOf.call(parent.childNodes, chip)
        : 0;
      chip.remove();

      const text = readCanonicalText(el);
      lastValue.current = text;
      onChange(text);

      // Leave the caret where the chip used to be.
      if (parent) {
        const range = document.createRange();
        range.setStart(parent, Math.min(index, parent.childNodes.length));
        range.collapse(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return true;
    }, [onChange]);

    const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
      if (
        !disabled
        && ((event.key === 'Backspace' && removeAdjacentChip('backward'))
          || (event.key === 'Delete' && removeAdjacentChip('forward')))
      ) {
        event.preventDefault();
        return;
      }
      onKeyDown(event);
    }, [disabled, onKeyDown, removeAdjacentChip]);

    const handleBeforeInput = useCallback((event: React.FormEvent<HTMLDivElement>) => {
      const inputType = (event.nativeEvent as InputEvent).inputType;
      const direction = inputType === 'deleteContentBackward'
        ? 'backward'
        : inputType === 'deleteContentForward'
          ? 'forward'
          : null;
      if (direction && !disabled && removeAdjacentChip(direction)) {
        event.preventDefault();
      }
    }, [disabled, removeAdjacentChip]);

    const handleCompositionStart = useCallback(() => {
      isComposing.current = true;
    }, []);

    const handleCompositionEnd = useCallback(() => {
      isComposing.current = false;
      const el = innerRef.current;
      if (!el) return;
      const text = readCanonicalText(el);
      lastValue.current = text;
      onChange(text);
    }, [onChange]);

    return (
      <div
        ref={innerRef}
        className="w-full bg-transparent px-2 pt-2 pb-1 text-left text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[56px] max-h-[150px] overflow-y-auto empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground"
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        suppressContentEditableWarning
        data-placeholder={placeholder || ''}
        onInput={handleInput}
        onBeforeInput={handleBeforeInput}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        style={{
          wordBreak: 'break-word',
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
        }}
      />
    );
  }
);

RichTextInput.displayName = 'RichTextInput';
