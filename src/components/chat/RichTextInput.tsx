// RichTextInput.tsx - Plan 220 Phase 4.
//
// ContentEditable input that handles slash-command highlighting. Inline
// chip rendering was removed in Plan 220 — chips are now lifted to
// <AttachmentBar> above the editor and don't live inside the text
// stream. The DOM-mutation machinery that used to reconcile chip tokens
// is gone.
//
// Skill slash commands (`/docx`, `/commit`) are rendered as a blue bold
// inline chip with a leading cube icon. Clicking the chip opens the
// skill's SKILL.md in the side-panel preview. The chip is only rendered
// when the input value is exactly `/<skill-name>` (with optional trailing
// whitespace) so it doesn't interfere with typing arguments.

'use client';

import React, { useRef, useEffect, forwardRef, useCallback } from 'react';
import { parseSlashCommand, parseSkillToken } from '@/lib/message-input-logic';

interface RichTextInputProps {
  value: string;
  onChange: (val: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
}

function dispatchOpenSkillPreview(skillName: string): void {
  window.dispatchEvent(new CustomEvent('duya:open-skill-preview', {
    detail: { skillName },
  }));
}

function createSkillChip(skillName: string): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'inline-flex items-center gap-1';
  chip.style.color = '#3b82f6';
  chip.style.fontWeight = '700';
  chip.style.cursor = 'pointer';
  chip.style.userSelect = 'none';
  chip.dataset.skillChip = skillName;
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

// Extract user-typed text from the editable element.
function extractUserText(el: HTMLElement): string {
  return Array.from(el.childNodes)
    .map((n) => (n.nodeType === Node.TEXT_NODE ? n.textContent : (n as HTMLElement).textContent ?? ''))
    .join('');
}

export const RichTextInput = forwardRef<HTMLDivElement, RichTextInputProps>(
  ({
    value,
    onChange,
    onKeyDown,
    onPaste,
    placeholder,
    disabled,
  }, ref) => {
    const innerRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);
    const lastValue = useRef(value);

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
      const slashParsed = parseSlashCommand(text);
      el.innerHTML = '';

      if (skillToken) {
        const chip = createSkillChip(skillToken.skillName);
        el.appendChild(chip);
        const trailing = text.slice(text.trim().length);
        if (trailing) {
          el.appendChild(document.createTextNode(trailing));
        }
      } else if (slashParsed) {
        const { slashCommand, remainingText } = slashParsed;
        const slashSpan = document.createElement('span');
        slashSpan.dataset.slashCommand = 'true';
        slashSpan.textContent = slashCommand;
        slashSpan.style.color = 'var(--accent)';
        el.appendChild(slashSpan);
        if (remainingText) {
          const spaceText = document.createTextNode(' ');
          el.appendChild(spaceText);
          const restText = document.createTextNode(remainingText);
          el.appendChild(restText);
        }
      } else if (text) {
        el.appendChild(document.createTextNode(text));
      }

      // Keep the caret at the end after external rebuilds.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
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

    const handleInput = useCallback(() => {
      const el = innerRef.current;
      if (!el || isComposing.current) return;
      const text = extractUserText(el);
      lastValue.current = text;
      onChange(text);
      // Re-highlight on subsequent typing when slash command active.
      if (parseSlashCommand(text)) {
        buildContent(el, text);
      }
    }, [buildContent, onChange]);

    const handleCompositionStart = useCallback(() => {
      isComposing.current = true;
    }, []);

    const handleCompositionEnd = useCallback(() => {
      isComposing.current = false;
      const el = innerRef.current;
      if (!el) return;
      const text = extractUserText(el);
      lastValue.current = text;
      onChange(text);
    }, [onChange]);

    return (
      <div
        ref={innerRef}
        className="w-full bg-transparent px-2 pt-2 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[56px] max-h-[150px] overflow-y-auto empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground"
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        suppressContentEditableWarning
        data-placeholder={placeholder || ''}
        onInput={handleInput}
        onKeyDown={onKeyDown}
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