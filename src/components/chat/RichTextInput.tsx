// RichTextInput.tsx - Plan 220 Phase 4.
//
// ContentEditable input that handles slash-command highlighting. Inline
// chip rendering was removed in Plan 220 — chips are now lifted to
// <AttachmentBar> above the editor and don't live inside the text
// stream. The DOM-mutation machinery that used to reconcile chip tokens
// is gone.

'use client';

import React, { useRef, useEffect, forwardRef, useCallback } from 'react';
import { parseSlashCommand } from '@/lib/message-input-logic';

interface RichTextInputProps {
  value: string;
  onChange: (val: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
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

    // Build content with optional slash-command highlight span.
    const buildContent = useCallback((el: HTMLDivElement, text: string) => {
      const parsed = parseSlashCommand(text);
      el.innerHTML = '';
      if (parsed) {
        const { slashCommand, remainingText } = parsed;
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
      const text = el.textContent ?? '';
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
      const text = el.textContent ?? '';
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
          whiteSpace: 'pre-wrap',
        }}
      />
    );
  }
);

RichTextInput.displayName = 'RichTextInput';