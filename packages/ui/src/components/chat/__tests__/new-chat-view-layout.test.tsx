// @vitest-environment jsdom
/**
 * New-chat page layout (Claude parity, 2026-10-27).
 *
 * The page became a three-band column — greeting title, environment card in
 * the middle, composer pinned to the bottom — and the recent-threads list that
 * used to sit under the composer was removed outright.
 *
 * These tests pin the structure that the layout change introduced: the three
 * bands exist in the right order, the card shows the working directory and the
 * owning project, and the recent list is really gone.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const storeMocks = vi.hoisted(() => ({
  createThread: vi.fn(async () => ({ id: 'thread-1' })),
  setActiveThread: vi.fn(async () => undefined),
  addProjectFolder: vi.fn(),
  updateNewChatDraft: vi.fn(),
  clearNewChatDraft: vi.fn(),
  // Mirrors the real store: the preset is consumed, so it must not re-assert
  // itself over a later manual selection.
  clearNewChatPresetProject: vi.fn(() => {
    storeMocks.newChatPresetProject = null;
  }),
  projects: [] as Array<{ workingDirectory: string; projectName: string }>,
  isHydrated: true,
  newChatDraft: { text: '', attachments: [], hasContent: false },
  newChatPresetProject: null as { workingDirectory: string; projectName: string } | null,
}));

vi.mock('@/stores/conversation-store', () => ({
  useConversationStore: (selector?: (state: typeof storeMocks) => unknown) =>
    typeof selector === 'function' ? selector(storeMocks) : storeMocks,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    locale: 'en',
  }),
}));

vi.mock('@/hooks/useSettings', () => ({
  useSettings: () => ({
    settings: {},
    save: vi.fn(async () => undefined),
    loading: false,
  }),
}));

vi.mock('@/lib/ipc-client', () => ({
  getActiveProviderIPC: vi.fn(async () => null),
  listProvidersIPC: vi.fn(async () => []),
  updateThreadIPC: vi.fn(async () => undefined),
}));

vi.mock('@/components/ui/InputDialog', () => ({ InputDialog: () => null }));

// The composer is heavy and unrelated to this layout; stub it out.
vi.mock('../MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

import { NewChatView } from '../NewChatView';

describe('NewChatView Claude parity layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMocks.projects = [];
    storeMocks.newChatPresetProject = null;
  });

  it('lays out the title, the environment card and the composer in that order', async () => {
    const { container } = render(<NewChatView onSendMessage={vi.fn()} />);

    const layout = container.querySelector('.new-chat-layout');
    expect(layout).toBeTruthy();

    const bands = Array.from(layout!.children).map((el) => el.className);
    expect(bands[0]).toContain('new-chat-title');
    expect(bands[1]).toContain('new-chat-environment');
    expect(bands[2]).toContain('new-chat-composer');
  });

  it('keeps the greeting as the page title', async () => {
    render(<NewChatView onSendMessage={vi.fn()} />);
    // The greeting is time-of-day based; assert the title band carries one.
    const title = document.querySelector('.new-chat-title-label');
    expect(title).toBeTruthy();
    expect(title!.textContent?.length).toBeGreaterThan(0);
  });

  it('renders the environment card in the middle band', async () => {
    render(<NewChatView onSendMessage={vi.fn()} />);
    const card = screen.getByTestId('environment-card');
    expect(card).toBeTruthy();
    const environmentBand = document.querySelector('.new-chat-environment');
    expect(environmentBand?.contains(card)).toBe(true);
  });

  it('shows the working directory and the project that owns it', async () => {
    storeMocks.projects = [
      { workingDirectory: 'E:/Projects/duya', projectName: 'duya' },
    ];
    storeMocks.newChatPresetProject = {
      workingDirectory: 'E:/Projects/duya',
      projectName: 'duya',
    };

    render(<NewChatView onSendMessage={vi.fn()} />);

    await waitFor(() => {
      const input = document.querySelector('.environment-card-path-input') as HTMLInputElement | null;
      expect(input?.value).toBe('E:/Projects/duya');
    });
    expect(document.querySelector('.environment-card-project-name')?.textContent).toBe('duya');
  });

  it('offers a "choose environment" disclosure that opens the project list', async () => {
    render(<NewChatView onSendMessage={vi.fn()} />);
    const choose = document.querySelector('.environment-card-choose');
    expect(choose).toBeTruthy();
    expect(choose!.textContent).toContain('chat.chooseEnvironment');
  });

  it('no longer renders the recent-threads list', async () => {
    const { container } = render(<NewChatView onSendMessage={vi.fn()} />);
    expect(container.querySelector('.welcome-recent')).toBeNull();
    expect(container.querySelector('.recent-list')).toBeNull();
    expect(container.querySelector('.recent-item')).toBeNull();
    expect(screen.queryByText('chat.recentThreads')).toBeNull();
  });

  it('switches to a known project when its path is committed with Enter', async () => {
    storeMocks.projects = [
      { workingDirectory: 'E:/Projects/duya', projectName: 'duya' },
      { workingDirectory: 'E:/Projects/other', projectName: 'other' },
    ];
    storeMocks.newChatPresetProject = {
      workingDirectory: 'E:/Projects/duya',
      projectName: 'duya',
    };

    render(<NewChatView onSendMessage={vi.fn()} />);

    const input = (await waitFor(() =>
      document.querySelector('.environment-card-path-input'),
    )) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('E:/Projects/duya'));

    fireEvent.change(input, { target: { value: 'E:/Projects/other' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(document.querySelector('.environment-card-project-name')?.textContent).toBe('other');
    });
    // A path duya already knows must not be registered again.
    expect(storeMocks.addProjectFolder).not.toHaveBeenCalled();
  });

  it('registers an unknown path as a new project when it is committed', async () => {
    storeMocks.projects = [{ workingDirectory: 'E:/Projects/duya', projectName: 'duya' }];
    storeMocks.newChatPresetProject = {
      workingDirectory: 'E:/Projects/duya',
      projectName: 'duya',
    };
    storeMocks.addProjectFolder.mockResolvedValueOnce({
      workingDirectory: 'E:/Projects/fresh',
      projectName: 'fresh',
    });

    render(<NewChatView onSendMessage={vi.fn()} />);

    const input = (await waitFor(() =>
      document.querySelector('.environment-card-path-input'),
    )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'E:/Projects/fresh' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(storeMocks.addProjectFolder).toHaveBeenCalledWith('E:/Projects/fresh');
    });
    await waitFor(() => {
      expect(document.querySelector('.environment-card-project-name')?.textContent).toBe('fresh');
    });
  });
});
