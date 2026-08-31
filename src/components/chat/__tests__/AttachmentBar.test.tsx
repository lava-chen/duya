/**
 * AttachmentBar.test.tsx - failing-baseline tests for the unified attachment
 * renderer (Plan 220) plus the unified-square visual (Plan 472).
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

function browserScreenshotPair(imageId: string, refId: string): FileAttachment[] {
  return [
    imageAttachment(imageId),
    {
      kind: 'browser-ref',
      id: refId,
      name: 'Screenshot',
      type: 'text/plain',
      url: '',
      size: 0,
      text: 'Browser screenshot reference: page snapshot',
      previewText: 'Page title',
      metadata: {
        url: 'https://example.com',
        elementKind: 'screenshot',
        attachmentId: imageId,
        title: 'Page title',
      },
    },
  ];
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

describe('AttachmentBar (Plan 220 Phase 0 + Plan 472 unified visual)', () => {
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

    // Plan 472: all 5 kinds now expose a `data-attachment-id` wrapper
    // (the image kind picks it up via FileAttachmentCard, the rest via
    // ReferenceSquareCard / BrowserScreenshotCard).
    for (const att of attachments) {
      expect(
        container.querySelector(`[data-attachment-id="${att.id}"]`),
      ).toBeInTheDocument();
    }
    expect(container.querySelectorAll('[data-attachment-id]').length).toBe(5);
  });

  // Plan 472: image + pasted-text share one flex-wrap row, not two
  // stacked tracks as before the merge.
  it('places image and pasted-text cards inside one shared flex-wrap row', () => {
    const attachments: FileAttachment[] = [
      pastedAttachment('p1', 'preview one'),
      imageAttachment('i1'),
      pastedAttachment('p2', 'preview two'),
    ];

    const { container } = render(
      <AttachmentBar
        attachments={attachments}
        mode="input"
        onRemove={() => {}}
      />,
    );

    const wrappers = container.querySelectorAll('[data-attachment-id]');
    expect(wrappers).toHaveLength(3);
    const parent = wrappers[0].parentElement;
    expect(parent).not.toBeNull();
    expect(parent).toHaveClass('flex', 'flex-wrap', 'gap-2', 'mb-2');
    // Every attachment wrapper shares the same flex-wrap parent
    for (const w of Array.from(wrappers)) {
      expect(w.parentElement).toBe(parent);
    }
  });

  // Plan 472: input-array order is preserved on the unified row.
  it('renders mixed attachments in their input-array order', () => {
    const ordered: FileAttachment[] = [
      imageAttachment('i1'),
      pastedAttachment('p1', 'a'),
      terminalAttachment('t1'),
      fileTreeAttachment('f1'),
      browserElementAttachment('b1'),
    ];

    const { container } = render(
      <AttachmentBar
        attachments={ordered}
        mode="input"
        onRemove={() => {}}
      />,
    );

    const ids = Array.from(container.querySelectorAll('[data-attachment-id]')).map(
      (el) => el.getAttribute('data-attachment-id'),
    );
    expect(ids).toEqual(['i1', 'p1', 't1', 'f1', 'b1']);
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

  it('renders a browser screenshot as a single square preview card', () => {
    const attachments = browserScreenshotPair('img1', 'ref1');

    const { container } = render(
      <AttachmentBar
        attachments={attachments}
        mode="input"
        onRemove={() => {}}
      />,
    );

    expect(container.querySelectorAll('.browser-screenshot-attachment-card')).toHaveLength(1);
    // Plan 472: the chip selector (`pasted-content-attachment`) is replaced
    // by `reference-attachment-card`. The browser-ref here is a screenshot
    // so it stays inside the browser-screenshot track, never
    // ReferenceSquareCard.
    expect(container.querySelectorAll('.reference-attachment-card')).toHaveLength(0);
    expect(container.querySelectorAll('[data-attachment-id="ref1"]')).toHaveLength(1);
    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();
  });
});
