// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RichTextInput } from './RichTextInput';

describe('RichTextInput slash highlighting', () => {
  it('highlights a slash token as soon as it is typed', () => {
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
    expect(input.querySelector('[data-slash-command]')).toHaveTextContent('/do');
  });
});
