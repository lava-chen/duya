// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Translation returns the key so assertions match i18n keys directly.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

// Unified attachment state — keep it controlled and empty for the composer tests.
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: () => ({
    attachments: [],
    addFile: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  }),
}));

// Icons barrel pulls in @tabler/icons-react (heap heavy in tests).
vi.mock('@/components/icons', () => ({
  ArrowUpIcon: () => null,
  PlusIcon: () => null,
  XIcon: () => null,
}));

// BotCharacterAvatar renders avatars; stub it to null for unit tests.
vi.mock('@/components/layout/sidebar/BotCharacterAvatar', () => ({
  BotCharacterAvatar: () => null,
}));

// Bot-only extras mount useSlashCommands + SlashCommandPopover (heavy chain).
// Stub it; the + button visuals live in the top Composer and stay assertable.
vi.mock('./BotComposerExtras', () => ({
  BotComposerExtras: () => null,
}));

import { Composer, type ComposerProps, type ComposerPayload } from './Composer';

function setup(overrides: Partial<ComposerProps> = {}) {
  const onSubmit = vi.fn<(payload: ComposerPayload) => void>();
  render(
    <Composer
      draftKey="draft:1"
      onSubmit={onSubmit}
      inputTestId="c-in"
      sendTestId="c-send"
      mentionListTestId="c-mentions"
      {...overrides}
    />,
  );
  return { onSubmit };
}

function getInput(): HTMLTextAreaElement {
  return screen.getByTestId('c-in') as HTMLTextAreaElement;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe('Composer (shared shell)', () => {
  it('sends trimmed text through onSubmit and clears the field', () => {
    const { onSubmit } = setup();
    const input = getInput();
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByTestId('c-send'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
    expect(getInput().value).toBe('');
  });

  it('does not send empty or whitespace-only text', () => {
    const { onSubmit } = setup();
    fireEvent.change(getInput(), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('c-send'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends on Enter and inserts a newline on Shift+Enter', () => {
    const { onSubmit } = setup();
    fireEvent.change(getInput(), { target: { value: 'hi' } });
    fireEvent.keyDown(getInput(), { key: 'Enter', shiftKey: false });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ text: 'hi' }));
    expect(getInput().value).toBe('');
    fireEvent.change(getInput(), { target: { value: 'a' } });
    fireEvent.keyDown(getInput(), { key: 'Enter', shiftKey: true });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(getInput().value).toBe('a');
  });

  it('shows the stop button when busy and onStop are set', () => {
    setup({ busy: true, onStop: vi.fn() });
    expect(screen.getByLabelText('bot.chat.stop')).toBeDefined();
    expect(screen.queryByTestId('c-send')).toBeNull();
  });

  it('renders the + button when showPlus is enabled', () => {
    setup({ showPlus: true });
    expect(screen.getByLabelText('common.settings')).toBeDefined();
  });
});

describe('Composer (group mention autocomplete)', () => {
  const members = [
    { id: 'u1', name: 'Alice' },
    { id: 'u2', name: 'Bob' },
  ];

  it('lists matching members on `@` and inserts on click', () => {
    setup({ enableMentions: true, mentionMembers: members });
    fireEvent.change(getInput(), { target: { value: '@Al' } });
    const list = screen.getByTestId('c-mentions');
    expect(list).toBeDefined();
    fireEvent.click(screen.getByText('Alice'));
    expect(getInput().value).toBe('@Alice ');
  });

  it('renders no mention list when enableMentions is off', () => {
    setup({ mentionMembers: members });
    fireEvent.change(getInput(), { target: { value: '@Al' } });
    expect(screen.queryByTestId('c-mentions')).toBeNull();
  });
});