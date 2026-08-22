/**
 * MessageInputPaste.test.tsx - paste format-stripping behavior.
 *
 * Drives the REAL RichTextInput mounted inside MessageInput and fires
 * synthetic ClipboardEvents at it. jsdom does not implement
 * document.execCommand, so it is stubbed and asserted instead: the
 * handler must preventDefault every text paste and route the content
 * through `insertText` with a PLAIN string (never the HTML payload).
 *
 * The module mocks mirror `MessageInput.test.tsx` (they keep the
 * import chain slim) — except RichTextInput stays real here.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

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
  CircleIcon: () => null,
  SpinnerIcon: () => null,
  GitBranchIcon: () => null,
  PinIcon: () => null,
  ChalkboardIcon: () => null,
  TargetArrowIcon: () => null,
  ChatCircleIcon: () => null,
  HandIcon: () => null,
  ShieldCheckIcon: () => null,
  ShieldWarningIcon: () => null,
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

vi.mock('@/components/chat/FileAttachmentCard', () => ({
  FileAttachmentCard: () => null,
}));

vi.mock('@/components/chat/AttachmentBar', () => ({
  AttachmentBar: () => <div data-testid="attachment-bar" />,
}));

vi.mock('@/components/chat/InlineTaskRow', () => ({
  InlineTaskRow: () => null,
}));

vi.mock('@/components/chat/Popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
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

const { MessageInput } = await import('../MessageInput');

// jsdom implements neither DataTransfer nor ClipboardEvent constructors,
// so a plain 'paste' Event carries a faked clipboardData that satisfies
// the handler's contract (items.length + getData).
function firePaste(editor: HTMLElement, flavors: Record<string, string>): boolean {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: { length: 0 },
      getData: (type: string) => flavors[type] ?? '',
    },
  });
  editor.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('MessageInput paste format stripping', () => {
  let execCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execCommand = vi.fn(() => true);
    document.execCommand = execCommand as unknown as typeof document.execCommand;
  });

  function mount(): HTMLElement {
    const { container } = render(<MessageInput onSend={vi.fn()} sessionId="s-test" />);
    const editor = container.querySelector<HTMLElement>('[role="textbox"]');
    if (!editor) throw new Error('RichTextInput editor not found');
    editor.focus();
    return editor;
  }

  it('strips rich formatting: pastes the plain flavor, never styled markup', () => {
    const editor = mount();

    const prevented = firePaste(editor, {
      'text/html': '<span style="color:red">红色文字</span><b>粗体内容</b>',
      'text': '红色文字粗体内容',
    });

    expect(prevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '红色文字粗体内容');
  });

  it('falls back to html→text extraction when no text/plain flavor exists', () => {
    const editor = mount();

    const prevented = firePaste(editor, {
      'text/html': '<div><span style="color:#ff0000;font-weight:bold">仅HTML片段</span></div><div>第二行内容</div>',
    });

    expect(prevented).toBe(true);
    expect(execCommand).toHaveBeenCalledTimes(1);
    const inserted = execCommand.mock.calls[0][2] as string;
    expect(inserted).toContain('仅HTML片段');
    expect(inserted).toContain('第二行内容');
    expect(inserted.toLowerCase()).not.toContain('<span');
    expect(inserted.toLowerCase()).not.toContain('style=');
  });

  it('still prevents default when both flavors are empty', () => {
    const editor = mount();

    const prevented = firePaste(editor, {});

    // preventDefault always runs; the trailing insertText('') is a
    // browser-side no-op that leaves the editor untouched.
    expect(prevented).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('insertText', false, '');
  });
});
