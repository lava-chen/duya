// RichTextInput.tsx - ContentEditable input with slash command highlighting and inline file chips

'use client';

import React, { useRef, useEffect, forwardRef, useCallback } from 'react';
import { parseSlashCommand } from '@/lib/message-input-logic';
import { FileIcon, XIcon } from '@/components/icons';

export interface FileChipData {
  id: string;
  name: string;
  path: string;
}

interface RichTextInputProps {
  value: string;
  onChange: (val: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  placeholder?: string;
  disabled?: boolean;
  fileChips?: FileChipData[];
  onRemoveFileChip?: (id: string) => void;
}

function createFileChipElement(chip: FileChipData, onRemove?: (id: string) => void): HTMLSpanElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'file-chip-wrapper';
  wrapper.style.display = 'inline-flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.gap = '4px';
  wrapper.style.marginRight = '2px';
  wrapper.contentEditable = 'false';

  const chipSpan = document.createElement('span');
  chipSpan.className = 'file-chip';
  chipSpan.style.display = 'inline-flex';
  chipSpan.style.alignItems = 'center';
  chipSpan.style.gap = '4px';
  chipSpan.style.padding = '2px 6px';
  chipSpan.style.borderRadius = '4px';
  chipSpan.style.fontSize = '12px';
  chipSpan.style.backgroundColor = 'var(--accent-soft)';
  chipSpan.style.color = 'var(--accent)';
  chipSpan.style.verticalAlign = 'middle';
  chipSpan.dataset.chipId = chip.id;
  chipSpan.dataset.chipName = chip.name;
  chipSpan.dataset.chipPath = chip.path;

  const iconSpan = document.createElement('span');
  iconSpan.style.display = 'inline-flex';
  iconSpan.style.alignItems = 'center';
  iconSpan.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = chip.name;
  nameSpan.style.maxWidth = '150px';
  nameSpan.style.overflow = 'hidden';
  nameSpan.style.textOverflow = 'ellipsis';
  nameSpan.style.whiteSpace = 'nowrap';

  chipSpan.appendChild(iconSpan);
  chipSpan.appendChild(nameSpan);

  if (onRemove) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.style.display = 'inline-flex';
    removeBtn.style.alignItems = 'center';
    removeBtn.style.justifyContent = 'center';
    removeBtn.style.marginLeft = '2px';
    removeBtn.style.padding = '0';
    removeBtn.style.border = 'none';
    removeBtn.style.background = 'none';
    removeBtn.style.cursor = 'pointer';
    removeBtn.style.opacity = '0.6';
    removeBtn.style.color = 'var(--accent)';
    removeBtn.style.fontSize = '10px';
    removeBtn.style.lineHeight = '1';
    removeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    removeBtn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      onRemove(chip.id);
    };
    chipSpan.appendChild(removeBtn);
  }

  wrapper.appendChild(chipSpan);
  return wrapper;
}

export const RichTextInput = forwardRef<HTMLDivElement, RichTextInputProps>(
  ({ value, onChange, onKeyDown, onPaste, placeholder, disabled, fileChips = [], onRemoveFileChip }, ref) => {
    const innerRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);
    const lastValue = useRef(value);
    const lastChips = useRef<FileChipData[]>([]);

    // Sync forwarded ref
    useEffect(() => {
      if (typeof ref === 'function') {
        ref(innerRef.current);
      } else if (ref) {
        ref.current = innerRef.current;
      }
    }, [ref]);

    // Extract plain text from contentEditable, excluding chip elements
    const extractText = useCallback((el: HTMLDivElement): string => {
      let text = '';
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const el = node as HTMLElement;
            if (el.classList.contains('file-chip-wrapper') || el.closest('.file-chip-wrapper')) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent;
        }
      }
      return text;
    }, []);

    // Build content with file chips and text
    const buildContent = useCallback((el: HTMLDivElement, text: string, chips: FileChipData[]) => {
      // Check if chips changed
      const chipsChanged = chips.length !== lastChips.current.length ||
        chips.some((c, i) => c.id !== lastChips.current[i]?.id);

      // If only text changed and chips are the same, preserve chips and update text
      if (!chipsChanged && el.childNodes.length > 0) {
        // Find text nodes and update them
        const textNodes: Text[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
          textNodes.push(node as Text);
        }
        const currentText = textNodes.map(n => n.textContent).join('');
        if (currentText === text) return; // No change needed
      }

      lastChips.current = [...chips];

      // Clear and rebuild
      el.innerHTML = '';

      // Add text content with slash command highlighting
      if (text) {
        const parsed = parseSlashCommand(text);

        if (parsed) {
          const { slashCommand, remainingText } = parsed;
          // Create slash command span (purple color)
          const slashSpan = document.createElement('span');
          slashSpan.textContent = slashCommand;
          slashSpan.style.color = 'var(--accent)';
          el.appendChild(slashSpan);

          // Add remaining text
          if (remainingText) {
            const spaceText = document.createTextNode(' ');
            el.appendChild(spaceText);
            const restText = document.createTextNode(remainingText);
            el.appendChild(restText);
          }
        } else {
          const textNode = document.createTextNode(text);
          el.appendChild(textNode);
        }
      }

      // Add file chips
      for (const chip of chips) {
        // Add space before chip if there's text or previous chip
        if (el.lastChild) {
          const space = document.createTextNode(' ');
          el.appendChild(space);
        }
        const chipEl = createFileChipElement(chip, onRemoveFileChip);
        el.appendChild(chipEl);
      }
    }, [onRemoveFileChip]);

    // Update content when value or chips change externally
    useEffect(() => {
      const el = innerRef.current;
      if (!el || isComposing.current) return;

      if (value !== lastValue.current || fileChips.length !== lastChips.current.length) {
        lastValue.current = value;
        buildContent(el, value, fileChips);
      }
    }, [value, fileChips, buildContent]);

    const handleInput = useCallback(() => {
      const el = innerRef.current;
      if (!el || isComposing.current) return;

      const text = extractText(el);
      lastValue.current = text;
      onChange(text);
    }, [onChange, extractText]);

    const handleCompositionStart = useCallback(() => {
      isComposing.current = true;
    }, []);

    const handleCompositionEnd = useCallback(() => {
      isComposing.current = false;
      const el = innerRef.current;
      if (!el) return;

      const text = extractText(el);
      lastValue.current = text;
      onChange(text);
    }, [onChange, extractText]);

    return (
      <div
        ref={innerRef}
        className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[40px] max-h-[150px] overflow-y-auto empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground"
        contentEditable={!disabled}
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
