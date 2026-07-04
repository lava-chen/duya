/**
 * useAttachments.test.ts - failing-baseline tests for the unified attachment
 * state hook introduced by Plan 220.
 *
 * These tests are written FIRST (TDD baseline) and **must fail** against the
 * current code, because `useAttachments` and the `FileAttachment.kind` /
 * `previewText` / `metadata` discriminator do not exist yet. Phase 1 of
 * Plan 220 implements the hook and these tests start passing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAttachments } from '../useAttachments';
import type { FileAttachment } from '@/types/message';

// File parsing in jsdom requires `FileReader` and `window.electronAPI.parser`.
// We stub both so `addFile` exercises the "non-document" (image) path; the
// document-parse path is tested separately with a separate hook.
class FakeFileReader {
  public result: string | ArrayBuffer | null = null;
  public onload: ((ev: ProgressEvent) => void) | null = null;
  public onerror: ((ev: ProgressEvent) => void) | null = null;
  readAsDataURL(blob: Blob) {
    // Synchronous-ish: resolve to a tiny data URL.
    this.result = 'data:text/plain;base64,aGVsbG8=';
    queueMicrotask(() => this.onload?.({} as ProgressEvent));
  }
}

// @ts-expect-error - assigning to global stub
global.FileReader = FakeFileReader;

beforeEach(() => {
  // @ts-expect-error - stub the Electron parser API; not used in these tests
  window.electronAPI = { parser: undefined };
});

function fakeImageFile(name = 'pasted.png', type = 'image/png'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe('useAttachments — unified attachment state (Plan 220 Phase 0 baseline)', () => {
  it('exposes a single attachments array (no separate chip carriers)', () => {
    const { result } = renderHook(() => useAttachments());
    expect(Array.isArray(result.current.attachments)).toBe(true);
    expect(result.current.attachments).toHaveLength(0);
  });

  it('addAttachment appends a pasted-text attachment with kind + previewText', () => {
    const { result } = renderHook(() => useAttachments());
    const pasted: FileAttachment = {
      kind: 'pasted-text',
      id: 'p1',
      name: 'long-paste-preview',
      type: 'text/plain',
      url: '',
      size: 11,
      text: 'paste body',
      previewText: 'long-paste-preview',
    };

    act(() => {
      result.current.addAttachment(pasted);
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0]).toMatchObject({
      kind: 'pasted-text',
      id: 'p1',
      text: 'paste body',
      previewText: 'long-paste-preview',
    });
  });

  it('buildModelContent concatenates pasted-text bodies before the typed input', () => {
    const { result } = renderHook(() => useAttachments());
    act(() => {
      result.current.addAttachment({
        kind: 'pasted-text',
        id: 'p1',
        name: 'preview',
        type: 'text/plain',
        url: '',
        size: 14,
        text: 'paste-text-here',
        previewText: 'preview',
      });
    });

    const out = result.current.buildModelContent('fix this');
    // Pasted text comes first, user input last, separated by blank line.
    expect(out).toContain('paste-text-here');
    expect(out).toContain('fix this');
    expect(out.indexOf('paste-text-here')).toBeLessThan(out.indexOf('fix this'));
  });

  it('buildModelContent returns the typed input unchanged when there are no attachments', () => {
    const { result } = renderHook(() => useAttachments());
    expect(result.current.buildModelContent('just text')).toBe('just text');
  });

  it('remove(id) drops the matching attachment', () => {
    const { result } = renderHook(() => useAttachments());
    act(() => {
      result.current.addAttachment({
        kind: 'pasted-text',
        id: 'p1',
        name: 'preview',
        type: 'text/plain',
        url: '',
        size: 1,
        text: 'a',
        previewText: 'preview',
      });
      result.current.addAttachment({
        kind: 'pasted-text',
        id: 'p2',
        name: 'preview2',
        type: 'text/plain',
        url: '',
        size: 1,
        text: 'b',
        previewText: 'preview2',
      });
    });

    act(() => {
      result.current.remove('p1');
    });

    expect(result.current.attachments.map((a) => a.id)).toEqual(['p2']);
  });

  it('addBrowserScreenshot adds both the ref and the paired image, and remove links them', () => {
    const { result } = renderHook(() => useAttachments());

    act(() => {
      result.current.addBrowserScreenshot(
        {
          url: 'https://example.com',
          elementKind: 'screenshot',
          title: 'Example',
          label: 'Screenshot',
          text: 'Browser screenshot reference: Example',
        },
        {
          kind: 'image',
          id: 'img1',
          name: 'shot.png',
          type: 'image/png',
          url: 'data:image/png;base64,XXX',
          size: 3,
        },
      );
    });

    expect(result.current.attachments).toHaveLength(2);
    const ref = result.current.attachments.find((a) => a.kind === 'browser-ref');
    const image = result.current.attachments.find((a) => a.kind === 'image');
    expect(ref).toBeDefined();
    expect(image).toBeDefined();
    // The browser-ref carries metadata.attachmentId pointing at the image id.
    expect(
      ref &&
        ref.kind === 'browser-ref' &&
        (ref.metadata as { attachmentId?: string } | undefined)?.attachmentId,
    ).toBe('img1');

    // Removing the image should also remove the linked ref.
    act(() => {
      result.current.remove('img1');
    });
    expect(result.current.attachments).toHaveLength(0);
  });

  it('clear() drops all attachments and resets parseErrors', () => {
    const { result } = renderHook(() => useAttachments());
    act(() => {
      result.current.addAttachment({
        kind: 'pasted-text',
        id: 'p1',
        name: 'preview',
        type: 'text/plain',
        url: '',
        size: 1,
        text: 'a',
        previewText: 'preview',
      });
    });

    expect(result.current.attachments).toHaveLength(1);
    act(() => {
      result.current.clear();
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.parseErrors.size).toBe(0);
  });

  it('hasUnparsedDocs is true when a document attachment has path but no text', () => {
    const { result } = renderHook(() => useAttachments());
    act(() => {
      result.current.addAttachment({
        kind: 'file',
        id: 'doc1',
        name: 'report.pdf',
        type: 'application/pdf',
        url: '/abs/path/report.pdf',
        size: 1024,
        path: '/abs/path/report.pdf',
        // text: undefined — parser hasn't filled it yet
      });
    });

    expect(result.current.hasUnparsedDocs).toBe(true);
  });

  it('hasUnparsedDocs is false for image attachments even without text', () => {
    const { result } = renderHook(() => useAttachments());
    act(() => {
      result.current.addAttachment({
        kind: 'image',
        id: 'img1',
        name: 'shot.png',
        type: 'image/png',
        url: 'data:image/png;base64,XXX',
        size: 3,
      });
    });

    expect(result.current.hasUnparsedDocs).toBe(false);
  });

  it('addFile routes a non-document file into a kind:image attachment', async () => {
    const { result } = renderHook(() => useAttachments());
    await act(async () => {
      await result.current.addFile(fakeImageFile());
    });

    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].kind).toBe('image');
  });
});