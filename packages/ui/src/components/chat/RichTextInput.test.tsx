// @vitest-environment jsdom

import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';
import type { PluginMentionTarget } from '@/lib/message-input-logic';

const TARGETS: PluginMentionTarget[] = [
  { pluginId: 'wechat-pay', name: 'WeChat Pay', iconUrl: 'duya-file:///icons/wechat.svg' },
];

/**
 * Controlled host that exposes an "insert" button. The @ popover insert path
 * changes `value` from the outside (not via a DOM input event), so the chip
 * build is driven by the prop change — this reproduces that exactly.
 */
function Harness({ targets = TARGETS }: { targets?: PluginMentionTarget[] }) {
  const [value, setValue] = useState('');
  return (
    <>
      <button onClick={() => setValue('hey @wechat-pay')}>insert</button>
      <RichTextInput
        value={value}
        onChange={setValue}
        onKeyDown={() => {}}
        onPaste={() => {}}
        placeholder="Message"
        mentionTargets={targets}
      />
    </>
  );
}

function caretToEnd(input: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(input);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe('RichTextInput slash highlighting', () => {
  it('renders an exact slash token as a skill chip and removes it atomically', () => {
    const onChange = vi.fn();
    render(
      <RichTextInput
        value=""
        onChange={onChange}
        onKeyDown={() => {}}
        onPaste={() => {}}
        placeholder="Message"
      />,
    );

    const input = screen.getByRole('textbox');
    input.textContent = '/do';
    fireEvent.input(input);

    expect(onChange).toHaveBeenCalledWith('/do');
    const skillChip = input.querySelector<HTMLElement>('[data-skill-chip="do"]');
    expect(skillChip).not.toBeNull();
    expect(skillChip?.contentEditable).toBe('false');

    const range = document.createRange();
    range.selectNodeContents(input);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.keyDown(input, { key: 'Backspace' });

    expect(onChange).toHaveBeenLastCalledWith('');
  });
});

describe('RichTextInput plugin mention chips', () => {
  it('renders an inserted @mention as an icon + blue code-font name chip', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox');

    fireEvent.click(screen.getByRole('button', { name: 'insert' }));

    const chip = input.querySelector<HTMLElement>('[data-plugin-mention="wechat-pay"]');
    expect(chip).not.toBeNull();
    expect(chip?.contentEditable).toBe('false');
    expect(chip?.dataset.mentionToken).toBe('@wechat-pay');
    // Brand icon rendered from the plugin icon URL.
    expect(chip?.querySelector('img')?.getAttribute('src')).toBe('duya-file:///icons/wechat.svg');

    const label = chip?.querySelector('span');
    expect(label?.textContent).toBe('WeChat Pay');
    expect(label?.style.fontFamily).toContain('Fira Mono');
    expect(label?.style.color.replace(/\s/g, '')).toMatch(/3b82f6|rgb\(59,130,246\)/);
  });

  it('chips a mention present in an initial (restored) value', () => {
    render(
      <RichTextInput
        value="hi @wechat-pay"
        onChange={() => {}}
        onKeyDown={() => {}}
        onPaste={() => {}}
        placeholder="Message"
        mentionTargets={TARGETS}
      />,
    );

    const input = screen.getByRole('textbox');
    expect(input.querySelector('[data-plugin-mention="wechat-pay"]')).not.toBeNull();
  });

  it('leaves an unresolved @token as plain text', () => {
    render(
      <RichTextInput
        value="email me @home"
        onChange={() => {}}
        onKeyDown={() => {}}
        onPaste={() => {}}
        placeholder="Message"
        mentionTargets={TARGETS}
      />,
    );

    const input = screen.getByRole('textbox');
    expect(input.querySelector('[data-plugin-mention]')).toBeNull();
    expect(input.textContent).toBe('email me @home');
  });

  it('removes the whole chip on one Backspace and restores the bare text', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox');
    fireEvent.click(screen.getByRole('button', { name: 'insert' }));
    expect(input.querySelector('[data-plugin-mention]')).not.toBeNull();

    caretToEnd(input);
    fireEvent.keyDown(input, { key: 'Backspace' });

    expect(input.querySelector('[data-plugin-mention]')).toBeNull();
    expect(input.textContent).toBe('hey ');
  });
});
