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

export const TERMINAL_REFERENCE_TOKEN_PREFIX = '\uE000terminal:';
export const TERMINAL_REFERENCE_TOKEN_SUFFIX = '\uE000';
export const BROWSER_REFERENCE_TOKEN_PREFIX = '\uE000browser:';
export const BROWSER_REFERENCE_TOKEN_SUFFIX = '\uE000';

export function terminalReferenceToken(id: string): string {
  return `${TERMINAL_REFERENCE_TOKEN_PREFIX}${id}${TERMINAL_REFERENCE_TOKEN_SUFFIX}`;
}

export function browserReferenceToken(id: string): string {
  return `${BROWSER_REFERENCE_TOKEN_PREFIX}${id}${BROWSER_REFERENCE_TOKEN_SUFFIX}`;
}

export interface TerminalReferenceChipData {
  id: string;
  shell: string;
  cwd: string;
  text: string;
}

export interface BrowserReferenceChipData {
  id: string;
  kind: 'element' | 'screenshot';
  label: string;
  title: string;
  url: string;
  content: string;
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
  terminalReferenceChips?: TerminalReferenceChipData[];
  onRemoveTerminalReferenceChip?: (id: string) => void;
  browserReferenceChips?: BrowserReferenceChipData[];
  onRemoveBrowserReferenceChip?: (id: string) => void;
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

function createTerminalReferenceChipElement(
  chip: TerminalReferenceChipData,
  onRemove?: (id: string) => void,
): HTMLSpanElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'terminal-reference-chip-wrapper';
  wrapper.contentEditable = 'false';
  wrapper.dataset.referenceId = chip.id;
  wrapper.dataset.referenceToken = terminalReferenceToken(chip.id);

  const chipSpan = document.createElement('span');
  chipSpan.className = 'terminal-reference-chip terminal-reference-chip-inline';
  chipSpan.title = `${chip.shell} - ${chip.cwd}\n${chip.text}`;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'terminal-reference-chip-remove';
  removeBtn.setAttribute('aria-label', 'Remove terminal reference');
  removeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  removeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove?.(chip.id);
  };

  const firstLine = chip.text.split(/\r?\n/).find((line) => line.trim())?.trim() || 'Terminal selection';
  const lineCount = chip.text.split(/\r?\n/).length;

  const labelSpan = document.createElement('span');
  labelSpan.className = 'terminal-reference-chip-label';
  labelSpan.textContent = firstLine;

  const metaSpan = document.createElement('span');
  metaSpan.className = 'terminal-reference-chip-meta';
  metaSpan.textContent = `${lineCount}行`;

  chipSpan.appendChild(removeBtn);
  chipSpan.appendChild(labelSpan);
  chipSpan.appendChild(metaSpan);
  wrapper.appendChild(chipSpan);
  return wrapper;
}

function createBrowserReferenceChipElement(
  chip: BrowserReferenceChipData,
  onRemove?: (id: string) => void,
): HTMLSpanElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'browser-reference-chip-wrapper';
  wrapper.contentEditable = 'false';
  wrapper.dataset.referenceId = chip.id;
  wrapper.dataset.referenceToken = browserReferenceToken(chip.id);

  const chipSpan = document.createElement('span');
  chipSpan.className = 'browser-reference-chip browser-reference-chip-inline';
  chipSpan.title = `${chip.title || chip.label}\n${chip.url}\n\n${chip.content}`;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'browser-reference-chip-remove';
  removeBtn.setAttribute('aria-label', 'Remove browser reference');
  removeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  removeBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove?.(chip.id);
  };

  const iconSpan = document.createElement('span');
  iconSpan.className = 'browser-reference-chip-icon';
  iconSpan.innerHTML = chip.kind === 'screenshot'
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7a2 2 0 0 1 2-2h2l1.5-2h5L16 5h2a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><circle cx="12" cy="13" r="3"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 7-6 2-2 6L5 3Z"/><path d="M13 12l5 5"/></svg>';

  const labelSpan = document.createElement('span');
  labelSpan.className = 'browser-reference-chip-label';
  labelSpan.textContent = chip.kind === 'screenshot' ? 'Screenshot' : chip.label || 'Element';

  const metaSpan = document.createElement('span');
  metaSpan.className = 'browser-reference-chip-meta';
  metaSpan.textContent = chip.title || labelFromUrl(chip.url);

  chipSpan.appendChild(removeBtn);
  chipSpan.appendChild(iconSpan);
  chipSpan.appendChild(labelSpan);
  chipSpan.appendChild(metaSpan);
  wrapper.appendChild(chipSpan);
  return wrapper;
}

function labelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || parsed.pathname || 'Page';
  } catch {
    return url || 'Page';
  }
}

export const RichTextInput = forwardRef<HTMLDivElement, RichTextInputProps>(
  ({
    value,
    onChange,
    onKeyDown,
    onPaste,
    placeholder,
    disabled,
    fileChips = [],
    onRemoveFileChip,
    terminalReferenceChips = [],
    onRemoveTerminalReferenceChip,
    browserReferenceChips = [],
    onRemoveBrowserReferenceChip,
  }, ref) => {
    const innerRef = useRef<HTMLDivElement>(null);
    const isComposing = useRef(false);
    const lastValue = useRef(value);
    const lastChips = useRef<FileChipData[]>([]);
    const lastTerminalChips = useRef<TerminalReferenceChipData[]>([]);
    const lastBrowserChips = useRef<BrowserReferenceChipData[]>([]);

    // Sync forwarded ref
    useEffect(() => {
      if (typeof ref === 'function') {
        ref(innerRef.current);
      } else if (ref) {
        ref.current = innerRef.current;
      }
    }, [ref]);

    // Extract plain text from contentEditable. File chips are out-of-band
    // attachments, while terminal reference chips keep an inline token so
    // they can live between words.
    const extractText = useCallback((el: HTMLDivElement): string => {
      const collect = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent ?? '';
        }
        if (node.nodeType !== Node.ELEMENT_NODE) {
          return '';
        }
        const element = node as HTMLElement;
        if (element.classList.contains('file-chip-wrapper') || element.closest('.file-chip-wrapper')) {
          return '';
        }
        if (element.classList.contains('terminal-reference-chip-wrapper')) {
          return element.dataset.referenceToken ?? '';
        }
        if (element.classList.contains('browser-reference-chip-wrapper')) {
          return element.dataset.referenceToken ?? '';
        }
        let text = '';
        element.childNodes.forEach((child) => {
          text += collect(child);
        });
        if (element.tagName === 'DIV' || element.tagName === 'P' || element.tagName === 'BR') {
          text += '\n';
        }
        return text;
      };

      let text = '';
      el.childNodes.forEach((child) => {
        text += collect(child);
      });
      return text.replace(/\n$/, '');
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

      const terminalById = new Map(terminalReferenceChips.map((chip) => [chip.id, chip]));
      const browserById = new Map(browserReferenceChips.map((chip) => [chip.id, chip]));
      const tokenPattern = /\uE000(terminal|browser):([^\uE000]+)\uE000/g;
      let cursor = 0;
      let hasAppended = false;

      const appendText = (part: string) => {
        if (!part) return;
        const parsed = parseSlashCommand(text);

        if (parsed && !hasAppended && part === text) {
          const { slashCommand, remainingText } = parsed;
          const slashSpan = document.createElement('span');
          slashSpan.textContent = slashCommand;
          slashSpan.style.color = 'var(--accent)';
          el.appendChild(slashSpan);
          if (remainingText) {
            const spaceText = document.createTextNode(' ');
            el.appendChild(spaceText);
            const restText = document.createTextNode(remainingText);
            el.appendChild(restText);
          }
        } else {
          el.appendChild(document.createTextNode(part));
        }
        hasAppended = true;
      };

      let match: RegExpExecArray | null;
      while ((match = tokenPattern.exec(text))) {
        appendText(text.slice(cursor, match.index));
        const type = match[1];
        const id = match[2];
        if (type === 'terminal') {
          const chip = terminalById.get(id);
          if (chip) {
            const chipEl = createTerminalReferenceChipElement(chip, onRemoveTerminalReferenceChip);
            el.appendChild(chipEl);
            hasAppended = true;
          }
        } else {
          const chip = browserById.get(id);
          if (chip) {
            const chipEl = createBrowserReferenceChipElement(chip, onRemoveBrowserReferenceChip);
            el.appendChild(chipEl);
            hasAppended = true;
          }
        }
        cursor = match.index + match[0].length;
      }
      appendText(text.slice(cursor));

      // Add file chips
      for (const chip of chips) {
        if (el.lastChild) {
          const space = document.createTextNode(' ');
          el.appendChild(space);
        }
        const chipEl = createFileChipElement(chip, onRemoveFileChip);
        el.appendChild(chipEl);
      }

      // Keep the caret at the end after external rebuilds. This is the same
      // coarse behavior the previous textarea-adjacent chip renderer had.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, [browserReferenceChips, onRemoveBrowserReferenceChip, onRemoveFileChip, onRemoveTerminalReferenceChip, terminalReferenceChips]);

    // Update content when value or chips change externally
    useEffect(() => {
      const el = innerRef.current;
      if (!el || isComposing.current) return;

      const terminalChipsChanged =
        terminalReferenceChips.length !== lastTerminalChips.current.length ||
        terminalReferenceChips.some((chip, index) => chip.id !== lastTerminalChips.current[index]?.id);
      const browserChipsChanged =
        browserReferenceChips.length !== lastBrowserChips.current.length ||
        browserReferenceChips.some((chip, index) => chip.id !== lastBrowserChips.current[index]?.id);

      if (value !== lastValue.current || fileChips.length !== lastChips.current.length || terminalChipsChanged || browserChipsChanged) {
        lastValue.current = value;
        lastTerminalChips.current = [...terminalReferenceChips];
        lastBrowserChips.current = [...browserReferenceChips];
        buildContent(el, value, fileChips);
      }
    }, [value, fileChips, terminalReferenceChips, browserReferenceChips, buildContent]);

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
        className="w-full bg-transparent px-2 pt-2 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-h-[56px] max-h-[150px] overflow-y-auto empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground"
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
