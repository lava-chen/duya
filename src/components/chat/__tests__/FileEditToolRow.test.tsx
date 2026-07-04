// @vitest-environment jsdom
//
// Vitest smoke test for the new FileEditToolRow.
//
// We assert the rendered DOM contract:
//   - verb text (Edited / Created) appears
//   - filename renders as a blue button
//   - +N -M git-style stats appear when stats > 0
//   - clicking the filename calls window.electronAPI.shell.openPath
//
// This complements the live Playwright UI verification described in
// docs/exec-plans/active/208-file-edit-tool-ui-redesign.md.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// jsdom doesn't implement matchMedia; the ToolActionsGroup / I18nProvider
// tree doesn't depend on it but downstream components might.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Stub the electron shell API so we can assert openPath is called.
const openPath = vi.fn(async () => '');
(window as unknown as { electronAPI: { shell: { openPath: typeof openPath; openExternal: () => Promise<string> } } }).electronAPI = {
  shell: { openPath, openExternal: vi.fn(async () => '') },
};

// Tests at the bottom of this file listen for these events to verify
// that side-panel dispatchers fire for the matching extensions. Provide
// a top-level stub so the failing-redirect tests can opt in without
// duplicating the listener registration.
function expectDispatch(
  eventName: string,
  filePathText: string,
  tool: ToolAction,
): { detail: Record<string, unknown> | null } {
  const captured: { detail: Record<string, unknown> | null } = { detail: null };
  const listener = (e: Event) => {
    captured.detail = (e as CustomEvent<Record<string, unknown>>).detail ?? null;
  };
  window.addEventListener(eventName, listener);
  try {
    // Clean any leftover DOM from a previous test before rendering the
    // next; vitest's jsdom is shared across tests in this file.
    cleanup();
    render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
    const fileBtn = screen.getByText(filePathText) as HTMLElement;
    act(() => {
      fireEvent.click(fileBtn);
    });
  } finally {
    window.removeEventListener(eventName, listener);
  }
  return captured;
}

import { I18nProvider } from '@/components/layout/I18nProvider';
import { ToolActionsGroup, type ToolAction } from '@/components/chat/ToolActionsGroup';

const i18n = ({ children }: { children: React.ReactNode }) => (
  <I18nProvider>{children}</I18nProvider>
);

describe('FileEditToolRow', () => {
  beforeEach(() => {
    openPath.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it('renders "Edited" verb and clickable blue filename for an edit tool', () => {
    const tool: ToolAction = {
      id: 't1',
      name: 'edit',
      input: {
        file_path: 'src/styles/styles.css',
        old_string: 'a\n',
        new_string: 'b\n',
      },
    };
    render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
    expect(screen.getByText('Edited')).toBeTruthy();
    const fileBtn = screen.getByTitle(/Open in default editor/i) as HTMLButtonElement;
    expect(fileBtn.textContent).toBe('styles.css');
    // jsdom doesn't process Tailwind, so the inline style is empty.
    // Assert the className contract: text-blue-500 (or its alpha variant)
    // must be present, signaling a clickable blue link.
    expect(fileBtn.className).toMatch(/text-blue-500/);
  });

  it('renders "Created" verb for a write/create_file tool', () => {
    const tool: ToolAction = {
      id: 't2',
      name: 'write',
      input: { file_path: 'src/new.ts', content: 'a\nb\nc\n' },
    };
    render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('new.ts')).toBeTruthy();
  });

  it('shows +N -M git-style stats during streaming (computed from input)', () => {
    const tool: ToolAction = {
      id: 't3',
      name: 'edit',
      input: {
        file_path: 'a.ts',
        old_string: 'line1\nline2\nline3\n',
        new_string: 'line1\nline2-modified\nline3\nline4\n',
      },
    };
    render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
    // Expect at least one "+" or "-" to be present in the row.
    const html = document.body.innerHTML;
    expect(/[+\-]\d+/.test(html)).toBe(true);
  });

  it('clicking the filename dispatches the file preview panel for source-code files', () => {
    const tool: ToolAction = {
      id: 't4',
      name: 'edit',
      input: {
        file_path: 'src/foo.ts',
        old_string: 'a',
        new_string: 'b',
      },
    };
    const { detail } = expectDispatch('duya:open-file-preview-panel', 'foo.ts', tool);
    // The preview-panel event fires with the resolved path.
    expect(detail).not.toBeNull();
    expect(detail!.filePath as string).toMatch(/foo\.ts$/);
    // The system shell must NOT be invoked for code files — that would
    // push the user out to an external editor.
    expect(openPath).not.toHaveBeenCalled();
  });

  it('does not toggle expansion when clicking the filename', () => {
    const tool: ToolAction = {
      id: 't5',
      name: 'edit',
      input: {
        file_path: 'src/x.ts',
        old_string: 'a',
        new_string: 'b',
      },
    };
    const { detail } = expectDispatch('duya:open-file-preview-panel', 'x.ts', tool);
    // The diff card never appears — the click goes to the side panel.
    expect(screen.queryByText(/Successfully edited/)).toBeNull();
    // The preview-panel event fired with the resolved path.
    expect(detail).not.toBeNull();
    expect(detail!.filePath as string).toMatch(/x\.ts$/);
    // The system shell was not invoked.
    expect(openPath).not.toHaveBeenCalled();
  });

  it('expands to show diff card on row click when result is present', () => {
    const tool: ToolAction = {
      id: 't6',
      name: 'edit',
      input: { file_path: 'a.ts', old_string: 'old\n', new_string: 'new\n' },
      result: 'Successfully edited a.ts\n\nChanged:\nold\n\nTo:\nnew\n',
    };
    render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
    // Click the row container (role=button). Find the row by the caret
    // since the verb text is also used in other places.
    const row = screen.getByRole('button', { name: /Edited/ });
    act(() => {
      fireEvent.click(row);
    });
    // The diff card should now show — it renders the result text via
    // SimpleDiffViewer, so we look for a "Success" badge which only
    // appears when expanded.
    expect(screen.getByText('Success')).toBeTruthy();
  });

  it('dispatches duya:open-browser-panel instead of shell.openPath for .html files', () => {
    const tool: ToolAction = {
      id: 't7',
      name: 'write',
      input: {
        file_path: 'E:\\projects\\duya\\public\\index.html',
        content: '<h1>hi</h1>',
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedDetail: Record<string, unknown> | null = null;
    const listener = (event: Event) => {
      capturedDetail = (event as CustomEvent<Record<string, unknown>>).detail ?? null;
    };
    window.addEventListener('duya:open-browser-panel', listener);

    try {
      render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
      const fileBtn = screen.getByText('index.html') as HTMLElement;
      act(() => {
        fireEvent.click(fileBtn);
      });

      // Browser panel event fired with the absolute file path.
      expect(capturedDetail).not.toBeNull();
      const detail = capturedDetail as unknown as Record<string, unknown>;
      expect(detail.url as string).toBe('E:\\projects\\duya\\public\\index.html');

      // The system shell must NOT be invoked for HTML files — that
      // would push the user out to an external browser window.
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('duya:open-browser-panel', listener);
    }
  });

  it('also dispatches the browser panel event for .htm (case-insensitive extension)', () => {
    const tool: ToolAction = {
      id: 't8',
      name: 'write',
      input: { file_path: 'C:\\site\\legacy.HTM', content: '<p>x</p>' },
    };

    let dispatched = false;
    const listener = () => {
      dispatched = true;
    };
    window.addEventListener('duya:open-browser-panel', listener);

    try {
      render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
      const fileBtn = screen.getByText('legacy.HTM') as HTMLElement;
      act(() => {
        fireEvent.click(fileBtn);
      });

      expect(dispatched).toBe(true);
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('duya:open-browser-panel', listener);
    }
  });

  it('dispatches duya:open-office-panel for .docx files (no shell.openPath)', () => {
    const tool: ToolAction = {
      id: 't9',
      name: 'write',
      input: { file_path: 'E:\\projects\\duya\\report.docx', content: '' },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedDetail: Record<string, unknown> | null = null;
    const listener = (event: Event) => {
      capturedDetail = (event as CustomEvent<Record<string, unknown>>).detail ?? null;
    };
    window.addEventListener('duya:open-office-panel', listener);

    try {
      render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
      const fileBtn = screen.getByText('report.docx') as HTMLElement;
      act(() => {
        fireEvent.click(fileBtn);
      });

      expect(capturedDetail).not.toBeNull();
      const detail = capturedDetail as unknown as Record<string, unknown>;
      expect(detail.filePath as string).toBe('E:\\projects\\duya\\report.docx');
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('duya:open-office-panel', listener);
    }
  });

  it('dispatches duya:open-office-panel for .pptx files (no shell.openPath)', () => {
    const tool: ToolAction = {
      id: 't10',
      name: 'write',
      input: { file_path: 'E:\\projects\\duya\\slides.pptx', content: '' },
    };

    let dispatched = false;
    const listener = () => {
      dispatched = true;
    };
    window.addEventListener('duya:open-office-panel', listener);

    try {
      render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
      const fileBtn = screen.getByText('slides.pptx') as HTMLElement;
      act(() => {
        fireEvent.click(fileBtn);
      });

      expect(dispatched).toBe(true);
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('duya:open-office-panel', listener);
    }
  });

  it('dispatches duya:open-file-preview-panel for .md files (no shell.openPath)', () => {
    const tool: ToolAction = {
      id: 't11',
      name: 'write',
      input: { file_path: 'E:\\projects\\duya\\notes.md', content: '# hi' },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let capturedDetail: Record<string, unknown> | null = null;
    const listener = (event: Event) => {
      capturedDetail = (event as CustomEvent<Record<string, unknown>>).detail ?? null;
    };
    window.addEventListener('duya:open-file-preview-panel', listener);

    try {
      render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
      const fileBtn = screen.getByText('notes.md') as HTMLElement;
      act(() => {
        fireEvent.click(fileBtn);
      });

      expect(capturedDetail).not.toBeNull();
      const detail = capturedDetail as unknown as Record<string, unknown>;
      expect(detail.filePath as string).toBe('E:\\projects\\duya\\notes.md');
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('duya:open-file-preview-panel', listener);
    }
  });

  it('dispatches duya:open-file-preview-panel for .png images', () => {
    const tool: ToolAction = {
      id: 't12',
      name: 'write',
      input: { file_path: 'E:\\projects\\duya\\cover.png', content: '' },
    };

    let dispatched = false;
    const listener = () => {
      dispatched = true;
    };
    window.addEventListener('duya:open-file-preview-panel', listener);

    try {
      render(i18n({ children: <ToolActionsGroup tools={[tool]} flat /> }));
      const fileBtn = screen.getByText('cover.png') as HTMLElement;
      act(() => {
        fireEvent.click(fileBtn);
      });

      expect(dispatched).toBe(true);
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('duya:open-file-preview-panel', listener);
    }
  });
});
