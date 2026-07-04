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
import { render, screen } from '@testing-library/react';
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
}));

vi.mock('@/components/chat/ModelSelector', () => ({
  ModelSelector: () => null,
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

vi.mock('@/lib/ipc-client', () => ({
  listProvidersIPC: vi.fn().mockResolvedValue([]),
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
});