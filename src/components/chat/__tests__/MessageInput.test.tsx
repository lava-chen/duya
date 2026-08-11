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
// so the test runs in a lean environment. The icons list covers what
// MessageInput and useSlashCommands import directly — keeping it explicit
// (rather than a Proxy) avoids vitest ESM-interop hangs.
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
  ClockCounterClockwiseIcon: () => null,
  FileTextIcon: () => null,
  ExternalLinkIcon: () => null,
  CaretDownIcon: () => null,
  TelescopeIcon: () => null,
  PlusIcon: () => null,
  TerminalIcon: () => null,
  QuestionIcon: () => null,
  BrainIcon: () => null,
  GlobeSimpleIcon: () => null,
  ListChecksIcon: () => null,
  FeatherIcon: () => null,
  PlugIcon: () => null,
  SquareHalfIcon: () => null,
  ArrowsInLineVerticalIcon: () => null,
  // Plan 416: InlineTaskRow renders these icons when there are
  // tasks / git changes for the current turn.
  CircleIcon: () => null,
  SpinnerIcon: () => null,
  GitBranchIcon: () => null,
  // useSlashCommands references PinIcon in a popover item; the
  // popover isn't open in any smoke test, but the icon is referenced
  // during render so it must be in the mock.
  PinIcon: () => null,
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

vi.mock('@/components/chat/InlineTaskRow', () => ({
  // Plan 416: InlineTaskRow is rendered inside MessageInput when
  // tasks/gitStatus props are passed. The smoke tests in this file
  // don't exercise it, so we mock it out to keep the import chain
  // slim (the real component pulls in usePanel → panels/registry →
  // CanvasToolbar, which uses icons the icons mock doesn't define).
  InlineTaskRow: () => null,
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

import { MessageInput, pickMessageMode, clearMessageModes } from '../MessageInput';

describe('MessageInput mode helpers (plan 413e)', () => {
  it('pickMessageMode returns plan-task (session-level) but skips conductor', () => {
    expect(pickMessageMode(new Set(['plan-task']))).toBe('plan-task');
    expect(pickMessageMode(new Set(['research']))).toBe('research');
    expect(pickMessageMode(new Set(['conductor']))).toBeUndefined();
    expect(pickMessageMode(new Set(['plan-task', 'conductor']))).toBe('plan-task');
  });

  it('clearMessageModes keeps session modes (plan-task, conductor) and drops research', () => {
    const next = clearMessageModes(new Set(['plan-task', 'research', 'conductor']));
    expect(next.has('plan-task')).toBe(true);
    expect(next.has('conductor')).toBe(true);
    expect(next.has('research')).toBe(false);
  });
});

describe('MessageInput plan-task session toggle (plan 413e)', () => {
  it('restores plan-task from the planModeEnabled prop and reports toggle-off', async () => {
    const onPlanModeChange = vi.fn();
    render(
      <MessageInput
        onSend={() => {}}
        planModeEnabled
        onPlanModeChange={onPlanModeChange}
      />,
    );
    // The sync effect surfaces the persisted toggle as a chip.
    const chip = await screen.findByText('Plan Mode');
    fireEvent.click(chip);
    expect(onPlanModeChange).toHaveBeenCalledWith(false);
  });

  it('shows the plan-task chip only while the persisted toggle is on', async () => {
    const { rerender } = render(<MessageInput onSend={() => {}} />);
    expect(screen.queryByText('Plan Mode')).not.toBeInTheDocument();
    rerender(<MessageInput onSend={() => {}} planModeEnabled />);
    expect(await screen.findByText('Plan Mode')).toBeInTheDocument();
    rerender(<MessageInput onSend={() => {}} planModeEnabled={false} />);
    expect(screen.queryByText('Plan Mode')).not.toBeInTheDocument();
  });
});

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
