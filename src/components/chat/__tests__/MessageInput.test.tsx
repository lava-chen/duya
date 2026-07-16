/**
 * MessageInput.test.tsx - smoke test after Plan 220 migration.
 *
 * Full integration tests of the MessageInput orchestrator are deferred
 * to Phase 8 (test coverage) — the orchestrator is too entangled with
 * IPC, slash commands, models, etc. to drive cleanly in isolation. This
 * smoke test just verifies that the component can mount after the
 * migration landed and that AttachmentBar is in the tree (smoke check
 * for the integration point).
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Heavy modules that MessageInput transitively imports. We mock them out
// so the test runs in a lean environment.
vi.mock('@/components/icons', () => ({
  ArrowUpIcon: () => null,
  SearchIcon: () => null,
  XIcon: () => null,
  StopIcon: () => null,
  XCircleIcon: () => null,
  PaperclipIcon: () => null,
  CheckIcon: () => null,
  CopyIcon: () => null,
  NotePencilIcon: () => null,
  ArrowCounterClockwiseIcon: () => null,
  FileTextIcon: () => null,
  ExternalLinkIcon: () => null,
  CaretDownIcon: () => null,
  TelescopeIcon: () => null,
  PlusIcon: () => null,
}));

vi.mock('@/components/chat/ModelSelector', () => ({
  ModelSelector: ({ onSelect }: { onSelect: (model: string) => void }) => (
    <button type="button" onClick={() => onSelect('[DeepSeek] deepseek-v4-flash')}>
      choose DeepSeek
    </button>
  ),
}));

vi.mock('@/components/chat/PermissionModeSelector', () => ({
  PermissionModeSelector: () => null,
}));

vi.mock('@/components/chat/SlashCommandPopover', () => ({
  SlashCommandPopover: () => null,
}));

vi.mock('@/components/chat/AttachmentMenu', () => ({
  AttachmentMenu: () => null,
}));

vi.mock('@/components/chat/ContextUsageRing', () => ({
  ContextUsageRing: () => null,
}));

vi.mock('@/components/chat/RichTextInput', () => ({
  RichTextInput: () => <div data-testid="rich-text-input" />,
}));

vi.mock('@/components/chat/FileAttachmentCard', () => ({
  FileAttachmentCard: () => null,
}));

vi.mock('@/components/chat/AttachmentBar', () => ({
  AttachmentBar: () => <div data-testid="attachment-bar" />,
}));

vi.mock('@/components/chat/Popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    locale: 'en',
    t: (key: string) => key,
  }),
}));

const mocks = vi.hoisted(() => ({
  listProvidersIPC: vi.fn(),
}));

vi.mock('@/lib/ipc-client', () => ({
  listProvidersIPC: mocks.listProvidersIPC,
  listOutputStylesIPC: vi.fn().mockResolvedValue([]),
  saveDraftIPC: vi.fn().mockResolvedValue(undefined),
  getDraftIPC: vi.fn().mockResolvedValue(''),
}));

import { MessageInput } from '../MessageInput';

describe('MessageInput (Plan 220 smoke test)', () => {
  it('mounts and renders the unified AttachmentBar after migration', () => {
    render(<MessageInput onSend={() => {}} />);

    // AttachmentBar should be present (the empty-state still emits the
    // element via the mocked component).
    expect(screen.getByTestId('attachment-bar')).toBeInTheDocument();
  });

  it('reports the selected model together with its provider', async () => {
    mocks.listProvidersIPC.mockResolvedValue([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        providerType: 'anthropic',
        hasApiKey: true,
        options: JSON.stringify({ enabled_models: ['deepseek-v4-flash'] }),
      },
    ]);
    const onModelChange = vi.fn();

    render(<MessageInput onSend={() => {}} onModelChange={onModelChange} />);

    await waitFor(() => expect(mocks.listProvidersIPC).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'choose DeepSeek' }));

    expect(onModelChange).toHaveBeenCalledWith(
      '[DeepSeek] deepseek-v4-flash',
      'deepseek',
    );
  });
});
