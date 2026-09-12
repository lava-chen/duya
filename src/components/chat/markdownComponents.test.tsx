/**
 * @vitest-environment jsdom
 */

import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { markdownComponents, MarkdownBaseDirectoryContext } from './markdownComponents';

vi.mock('./preview/ImagePreview', () => ({
  ImagePreview: () => <div data-testid="image-preview-modal" />,
}));

vi.mock('@/stores/conversation-store', () => ({
  // Mirror the MessageItem.test mock: without `threads`/`activeThreadId`
  // MarkdownAnchor throws at `threads.find(...)`. Default to a thread
  // with a known workingDirectory so chat-message tests can assert
  // "outside the workspace" routing. Tests that need a different cwd
  // override `activeThreadId` to point at a custom thread (see below).
  useConversationStore: (selector: (state: {
    parentSessionId: string | null;
    activeThreadId: string | null;
    threads: Array<{ id: string; workingDirectory?: string }>;
  }) => unknown) =>
    selector({
      parentSessionId: null,
      activeThreadId: 't-active',
      threads: [
        { id: 't-active', workingDirectory: '/Users/me/code/project' },
      ],
    }),
}));

vi.mock('@/hooks/useLinkOpener', () => ({
  useLinkOpener: () => ({
    openLinksInExternalBrowser: false,
    openLink: vi.fn(),
    setOpenLinksInExternalBrowser: vi.fn(),
  }),
}));

vi.mock('@/lib/link-favicon', () => ({
  useLinkFavicon: () => null,
}));

const Img = markdownComponents.img as React.FC<{ src?: string; alt?: string }>;

describe('rewriteMediaSrc', () => {
  it('strips a leading /abs/path placeholder from a Windows path', () => {
    render(<Img src="/abs/path/C:/Users/me/AppData/Local/Temp/duya-captures/canvas_1.png" alt="x" />);
    const img = screen.getByRole('img', { name: 'x' });
    expect(img).toHaveAttribute(
      'src',
      'duya-file:///C:/Users/me/AppData/Local/Temp/duya-captures/canvas_1.png',
    );
  });

  it('keeps a genuine Unix absolute path', () => {
    render(<Img src="/home/me/shots/canvas_1.png" alt="x" />);
    const img = screen.getByRole('img', { name: 'x' });
    expect(img).toHaveAttribute('src', 'duya-file:///home/me/shots/canvas_1.png');
  });
});

describe('MarkdownAnchor', () => {
  type Detail = {
    url?: string;
    filePath?: string;
    workingDirectory?: string | null;
    standalone?: boolean;
  };
  let dispatched: Array<{ event: string; detail: Detail }>;

  beforeEach(() => {
    dispatched = [];
    window.dispatchEvent = vi.fn((event: Event) => {
      const ce = event as CustomEvent<Detail>;
      dispatched.push({ event: ce.type, detail: ce.detail ?? {} });
      return true;
    }) as typeof window.dispatchEvent;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const Anchor = markdownComponents.a as React.FC<{ href?: string; children?: React.ReactNode }>;

  it('resolves a relative link against the base directory when provided', () => {
    render(
      <MarkdownBaseDirectoryContext.Provider value="E:\\other-project\\docs">
        <Anchor href="../sibling/app.ts">app.ts</Anchor>
      </MarkdownBaseDirectoryContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'app.ts' }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('E:\\other-project\\sibling\\app.ts');
    // Outside the chat workspace, the preview root falls back to the
    // file's own directory so files:preview accepts it.
    expect(dispatched[0].detail.workingDirectory).toBe('E:\\other-project\\sibling');
  });

  it('resolves a bare filename against the base directory when provided', () => {
    render(
      <MarkdownBaseDirectoryContext.Provider value="/Users/me/other-project/docs">
        <Anchor href="network.py">network.py</Anchor>
      </MarkdownBaseDirectoryContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'network.py' }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('/Users/me/other-project/docs/network.py');
  });

  // Chat-message scenario: no MarkdownBaseDirectoryContext.Provider
  // means we're rendering inside a chat message, not the sidebar file
  // preview. A click to a file outside the chat workspace must NOT
  // expose the file's parent directory as the preview panel's project
  // root (the previous fallback did exactly that). The renderer
  // signals "standalone" mode by setting workingDirectory="" and
  // standalone=true on the dispatched event.
  it('standalone preview for chat-message clicks outside the workspace', () => {
    render(<Anchor href="/Users/me/Downloads/notes.md">notes.md</Anchor>);
    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('/Users/me/Downloads/notes.md');
    expect(dispatched[0].detail.workingDirectory).toBe('');
    expect(dispatched[0].detail.standalone).toBe(true);
  });

  // Counterpart: chat-message click to a file INSIDE the chat workspace
  // must keep the cwd as the preview root, otherwise the user loses
  // the project tree even when clicking on a file in their own project.
  it('chat-message clicks inside the workspace keep the cwd as preview root', () => {
    render(
      <Anchor href="/Users/me/code/project/src/foo.ts">foo.ts</Anchor>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'foo.ts' }));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('/Users/me/code/project/src/foo.ts');
    expect(dispatched[0].detail.workingDirectory).toBe('/Users/me/code/project');
    expect(dispatched[0].detail.standalone).toBeUndefined();
  });

  // Regression: long Chinese file paths used to render as raw
  // percent-encoded text ("%E5%8F%91%E7%A5%A8...") and overflowed the
  // chat column instead of wrapping. Decoding the href before computing
  // the basename restores readable Chinese; the click target uses the
  // decoded form too so the OS gets a real path to open.
  it('decodes percent-encoded Chinese in a local file link for display and click', () => {
    render(
      <Anchor href="E:/lavachen/%E5%8F%91%E7%A5%A8%E5%A4%84%E7%90%86/%E5%8D%97%E4%BA%AC%E8%89%AF%E4%B8%9C%E6%9D%83%E5%90%89%E7%94%B5%E5%8A%9B%E8%90%A5%E8%B4%A2%E5%85%AC%E5%8F%B8_20260824130806.pdf">
        {undefined}
      </Anchor>,
    );
    // Visible text is the decoded basename. The decoded company name
    // is "南京良东权吉电力营财公司_20260824130806.pdf".
    expect(
      screen.getByText('南京良东权吉电力营财公司_20260824130806.pdf'),
    ).toBeInTheDocument();
    // Click target uses the decoded path so the OS can open the file.
    fireEvent.click(
      screen.getByRole('button', {
        name: '南京良东权吉电力营财公司_20260824130806.pdf',
      }),
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe(
      'E:\\lavachen\\发票处理\\南京良东权吉电力营财公司_20260824130806.pdf',
    );
  });

  // External link variant: a percent-encoded visible label should also
  // render decoded so users see the real URL instead of "%E5%8F%91".
  // The href is decoded too so the browser's hover / "Copy link" UI
  // shows the readable form.
  it('decodes percent-encoded Chinese in an external link label and href', () => {
    render(
      <Anchor href="https://example.com/%E5%8F%91%E7%A5%A8%E5%A4%84%E7%90%86">
        https://example.com/%E5%8F%91%E7%A5%A8%E5%A4%84%E7%90%86
      </Anchor>,
    );
    expect(
      screen.getByText('https://example.com/发票处理'),
    ).toBeInTheDocument();
    const link = screen.getByRole('link', {
      name: 'https://example.com/发票处理',
    });
    expect(link).toHaveAttribute('href', 'https://example.com/发票处理');
  });
});

describe('MarkdownImage', () => {
  it('renders a square thumbnail without a caption', () => {
    render(<Img src="https://example.com/pic.png" alt="diagram" />);

    const button = screen.getByRole('button', { name: /Enlarge image: diagram/i });
    expect(button).toHaveClass('markdown-image-button');

    const img = screen.getByRole('img', { name: 'diagram' });
    expect(img).toHaveClass('markdown-image');

    expect(screen.queryByText('diagram')).not.toBeInTheDocument();
    expect(button.querySelector('.markdown-image-caption')).not.toBeInTheDocument();
  });

  it('renders a thumbnail when alt is empty', () => {
    render(<Img src="https://example.com/pic.png" alt="" />);

    const button = screen.getByRole('button', { name: /Enlarge image/i });
    expect(button).toBeInTheDocument();
    expect(button.querySelector('img')).toHaveAttribute('alt', '');
  });
});
