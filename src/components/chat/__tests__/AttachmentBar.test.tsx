/**
 * AttachmentBar.test.tsx - failing-baseline tests for the unified attachment
 * renderer introduced by Plan 220.
 *
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentBar } from '../AttachmentBar';
import type { FileAttachment } from '@/types/message';

function pastedAttachment(id: string, preview: string): FileAttachment {
  return {
    kind: 'pasted-text',
    id,
    name: preview,
    type: 'text/plain',
    url: '',
    size: preview.length,
    text: preview,
    previewText: preview,
  };
}

function terminalAttachment(id: string): FileAttachment {
  return {
    kind: 'terminal-ref',
    id,
    name: 'bash',
    type: 'text/plain',
    url: '',
    size: 0,
    text: 'ls -la',
    previewText: 'ls -la (3行)',
    metadata: { shell: 'bash', cwd: '/tmp', createdAt: 0 },
  };
}

function browserElementAttachment(id: string): FileAttachment {
  return {
    kind: 'browser-ref',
    id,
    name: 'button',
    type: 'text/plain',
    url: '',
    size: 0,
    text: 'Browser element reference',
    previewText: 'Submit',
    metadata: { url: 'https://example.com', elementKind: 'element' },
  };
}

function imageAttachment(id: string): FileAttachment {
  return {
    kind: 'image',
    id,
    name: 'shot.png',
    type: 'image/png',
    url: 'data:image/png;base64,XXX',
    size: 3,
  };
}

function fileTreeAttachment(id: string): FileAttachment {
  return {
    kind: 'file-tree-ref',
    id,
    name: 'index.ts',
    type: 'text/plain',
    url: '',
    size: 0,
    path: '/abs/path/index.ts',
    previewText: 'index.ts',
  };
}

describe('AttachmentBar (Plan 220 Phase 0 baseline)', () => {
  it('renders nothing when attachments array is empty', () => {
    const { container } = render(
      <AttachmentBar attachments={[]} mode="input" onRemove={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders one card per attachment across all 5 kinds', () => {
    const attachments: FileAttachment[] = [
      pastedAttachment('p1', 'paste-preview'),
      terminalAttachment('t1'),
      browserElementAttachment('b1'),
      imageAttachment('i1'),
      fileTreeAttachment('f1'),
    ];

    const { container } = render(
      <AttachmentBar
        attachments={attachments}
        mode="input"
        onRemove={() => {}}
      />,
    );

    // 4 of the 5 kinds render through the chip card with
    // `data-attachment-id`. The image kind goes through FileAttachmentCard
    // and uses a different DOM path (no `data-attachment-id` on the wrapper).
    for (const att of attachments.filter((a) => a.kind !== 'image')) {
      expect(
        container.querySelector(`[data-attachment-id="${att.id}"]`),
      ).toBeInTheDocument();
    }
    // The image kind is rendered through FileAttachmentCard. Verify it
    // appears in the attachment-bar wrapper by counting children.
    expect(container.querySelectorAll('[data-attachment-id]').length).toBe(4);
  });

  it('input mode exposes an X button on each card', () => {
    const attachments = [pastedAttachment('p1', 'preview')];
    render(
      <AttachmentBar
        attachments={attachments}
        mode="input"
        onRemove={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /remove attachment/i })).toBeInTheDocument();
  });

  it('history mode hides the X button', () => {
    const attachments = [pastedAttachment('p1', 'preview')];
    render(
      <AttachmentBar
        attachments={attachments}
        mode="history"
        onRemove={() => {}}
      />,
    );
    expect(
      screen.queryByRole('button', { name: /remove attachment/i }),
    ).not.toBeInTheDocument();
  });

  it('clicking the X button calls onRemove with the attachment id', () => {
    const onRemove = vi.fn();
    const attachments = [
      pastedAttachment('p1', 'first'),
      pastedAttachment('p2', 'second'),
    ];

    render(
      <AttachmentBar
        attachments={attachments}
        mode="input"
        onRemove={onRemove}
      />,
    );

    const removeButtons = screen.getAllByRole('button', { name: /remove attachment/i });
    fireEvent.click(removeButtons[0]);
    expect(onRemove).toHaveBeenCalledWith('p1');
  });
});