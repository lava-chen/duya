// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';

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
