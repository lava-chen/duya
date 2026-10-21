// @vitest-environment jsdom
/**
 * ArchiveConfirm — Plan 582 (G9).
 *
 * The E2E suite (`e2e/ipc/session-archive-ui.spec.ts`) is what caught the
 * real defect this file now guards: the dialog used to render in place,
 * inside the sidebar, where it was visible but unclickable. `.app-body` and
 * `.app-workspace-row` are both `position: relative; z-index: auto`, so
 * each creates a stacking context, and the workspace row is a later sibling
 * of the sidebar — it painted over the overlay no matter how high the
 * overlay's own z-index went. Every Cancel / Archive click landed on the
 * chat composer behind it.
 *
 * jsdom does not do layout or stacking, so it cannot reproduce that. It CAN
 * pin the structural contract that prevents the regression: the dialog is
 * portalled to `document.body`, i.e. it is a sibling of the app root rather
 * than a descendant of whatever mounted it.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ArchiveConfirm } from './ArchiveConfirm';

// Translation returns the key plus params so assertions read like the i18n
// contract rather than a locale.
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) =>
      params ? `${k} ${Object.values(params).join(' ')}` : k,
  }),
}));

describe('ArchiveConfirm', () => {
  it('portals the dialog to document.body, not into the caller subtree', () => {
    const { container } = render(
      <div data-testid="caller-subtree">
        <ArchiveConfirm
          open
          title="Deploy the thing"
          childCount={0}
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </div>,
    );

    // The whole point: nothing rendered in place...
    expect(container.querySelector('[data-testid="archive-confirm"]')).toBeNull();
    expect(container.querySelector('[data-testid="caller-subtree"] > div')).toBeNull();

    // ...and the dialog is a child of <body>, i.e. outside every stacking
    // context the caller's ancestors might have created.
    const dialog = document.body.querySelector('[data-testid="archive-confirm"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.parentElement).toBe(document.body);
  });

  it('renders the thread title and the reversible hint', () => {
    render(
      <ArchiveConfirm
        open
        title="Deploy the thing"
        childCount={0}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByRole('dialog')).toHaveAttribute('data-testid', 'archive-confirm');
    expect(document.body.textContent).toContain('thread.archiveConfirmBody Deploy the thing');
    expect(document.body.textContent).toContain('thread.archiveConfirmHint');
  });

  it('mentions the sub-agent count only when there are children', () => {
    const { rerender } = render(
      <ArchiveConfirm
        open
        title="Parent"
        childCount={3}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(document.body.textContent).toContain('thread.archiveConfirmWithChildren 3');

    rerender(
      <ArchiveConfirm
        open
        title="Parent"
        childCount={0}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(document.body.textContent).not.toContain('thread.archiveConfirmWithChildren');
  });

  it('Cancel and Confirm route to their own callbacks', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ArchiveConfirm
        open
        title="Deploy the thing"
        childCount={0}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('archive-confirm-ok'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while closed', () => {
    render(
      <ArchiveConfirm
        open={false}
        title="Deploy the thing"
        childCount={0}
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    expect(document.querySelector('[data-testid="archive-confirm"]')).toBeNull();
  });
});
