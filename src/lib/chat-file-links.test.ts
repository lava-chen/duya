// @vitest-environment jsdom
//
// Unit tests for the helpers in src/lib/chat-file-links.ts that drive
// the chat-renderer click contract: which paths/URLs flow into the
// side-panel browser vs the system default app.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isHtmlFile,
  isOfficeFile,
  isLikelyLocalFileReference,
  isLocalhostUrl,
  isSidebarPreviewFile,
  resolveLocalFilePath,
  fileNameFromPath,
  extensionFromPath,
  openLocalArtifactTarget,
} from '@/lib/chat-file-links';

describe('chat-file-links / isHtmlFile', () => {
  it('matches .html and .htm (case-insensitive)', () => {
    expect(isHtmlFile('foo.html')).toBe(true);
    expect(isHtmlFile('foo.htm')).toBe(true);
    expect(isHtmlFile('foo.HTML')).toBe(true);
    expect(isHtmlFile('foo.HtM')).toBe(true);
  });

  it('rejects non-html extensions', () => {
    expect(isHtmlFile('foo.ts')).toBe(false);
    expect(isHtmlFile('foo.tsx')).toBe(false);
    expect(isHtmlFile('foo.md')).toBe(false);
    expect(isHtmlFile('foo')).toBe(false);
  });

  it('handles Windows-style paths', () => {
    expect(isHtmlFile('E:\\projects\\duya\\public\\index.html')).toBe(true);
    expect(isHtmlFile('E:/projects/duya/public/index.html')).toBe(true);
  });
});

describe('chat-file-links / isOfficeFile', () => {
  it('matches the full Office suite (case-insensitive)', () => {
    expect(isOfficeFile('report.doc')).toBe(true);
    expect(isOfficeFile('report.docx')).toBe(true);
    expect(isOfficeFile('deck.ppt')).toBe(true);
    expect(isOfficeFile('deck.pptx')).toBe(true);
    expect(isOfficeFile('sheet.xls')).toBe(true);
    expect(isOfficeFile('sheet.xlsx')).toBe(true);
    expect(isOfficeFile('Plan.DOCX')).toBe(true);
  });

  it('rejects non-Office extensions', () => {
    expect(isOfficeFile('archive.zip')).toBe(false);
    expect(isOfficeFile('image.png')).toBe(false);
    expect(isOfficeFile('index.html')).toBe(false);
    expect(isOfficeFile('plain.txt')).toBe(false);
    expect(isOfficeFile('noext')).toBe(false);
  });
});

describe('chat-file-links / isLikelyLocalFileReference', () => {
  it('matches file://, drive letters, and known extensions', () => {
    expect(isLikelyLocalFileReference('file:///etc/hosts')).toBe(true);
    expect(isLikelyLocalFileReference('E:\\foo\\bar.ts')).toBe(true);
    expect(isLikelyLocalFileReference('./relative.md')).toBe(true);
    expect(isLikelyLocalFileReference('/abs/path.md')).toBe(true);
    expect(isLikelyLocalFileReference('plain.txt')).toBe(true);
  });

  it('rejects external http(s) URLs without a local-file extension', () => {
    expect(isLikelyLocalFileReference('https://example.com/foo')).toBe(false);
    expect(isLikelyLocalFileReference('http://localhost:8000')).toBe(false);
  });
});

describe('chat-file-links / isLocalhostUrl', () => {
  it('matches localhost and 127.0.0.1 http(s) URLs', () => {
    expect(isLocalhostUrl('http://localhost')).toBe(true);
    expect(isLocalhostUrl('http://localhost:8000')).toBe(true);
    expect(isLocalhostUrl('http://localhost:8000/')).toBe(true);
    expect(isLocalhostUrl('http://localhost:8000/path/to/page')).toBe(true);
    expect(isLocalhostUrl('https://localhost:3000/secure')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1:8000/')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1/')).toBe(true);
  });

  it('rejects external hostnames and 0.0.0.0', () => {
    expect(isLocalhostUrl('https://example.com')).toBe(false);
    expect(isLocalhostUrl('https://127.0.0.1.example.com')).toBe(false);
    expect(isLocalhostUrl('http://0.0.0.0:8000/')).toBe(false);
  });

  it('rejects bare text, paths, and trailing whitespace artifacts', () => {
    expect(isLocalhostUrl('localhost')).toBe(false);
    expect(isLocalhostUrl('127.0.0.1')).toBe(false);
    expect(isLocalhostUrl('file:///tmp/x.html')).toBe(false);
    expect(isLocalhostUrl('')).toBe(false);
  });
});

describe('chat-file-links / resolveLocalFilePath', () => {
  it('joins relative paths onto a Windows cwd with backslashes', () => {
    expect(resolveLocalFilePath('foo.html', 'E:\\projects\\duya'))
      .toBe('E:\\projects\\duya\\foo.html');
    expect(resolveLocalFilePath('./foo.html', 'E:\\projects\\duya'))
      .toBe('E:\\projects\\duya\\.\\foo.html');
  });

  it('joins relative paths onto a Unix cwd with forward slashes', () => {
    expect(resolveLocalFilePath('foo.html', '/Users/duya/project'))
      .toBe('/Users/duya/project/foo.html');
    expect(resolveLocalFilePath('./foo.html', '/Users/duya/project'))
      .toBe('/Users/duya/project/./foo.html');
  });

  it('preserves absolute Windows paths', () => {
    expect(resolveLocalFilePath('E:\\foo\\bar.html', 'C:\\elsewhere'))
      .toBe('E:\\foo\\bar.html');
    expect(resolveLocalFilePath('E:/foo/bar.html', 'C:\\elsewhere'))
      .toBe('E:\\foo\\bar.html');
  });

  it('preserves absolute Unix paths', () => {
    expect(resolveLocalFilePath('/Users/duya/Downloads/_整理方案.md'))
      .toBe('/Users/duya/Downloads/_整理方案.md');
    expect(resolveLocalFilePath('/Users/duya/Downloads/_整理方案.md', 'E:\\project'))
      .toBe('/Users/duya/Downloads/_整理方案.md');
  });

  it('strips a trailing :line[:col] suffix before resolving', () => {
    expect(resolveLocalFilePath('foo.html:42', 'E:\\projects\\duya'))
      .toBe('E:\\projects\\duya\\foo.html');
    expect(resolveLocalFilePath('foo.html:42', '/Users/duya/project'))
      .toBe('/Users/duya/project/foo.html');
  });

  it('resolves file:// URLs to the host filesystem path', () => {
    expect(resolveLocalFilePath('file:///Users/duya/Downloads/_整理方案.md'))
      .toBe('/Users/duya/Downloads/_整理方案.md');
    expect(resolveLocalFilePath('file:///C:/Users/duya/file.html'))
      .toBe('C:\\Users\\duya\\file.html');
  });
});

describe('chat-file-links / path helpers', () => {
  it('fileNameFromPath returns the last segment', () => {
    expect(fileNameFromPath('E:\\a\\b\\c.html')).toBe('c.html');
    expect(fileNameFromPath('a/b/c.html')).toBe('c.html');
  });

  it('extensionFromPath returns the suffix (lowercased for matching)', () => {
    // The helper lowercases the result so consumers can match against
    // a lowercase extension set; preserve the trailing dot.
    expect(extensionFromPath('foo.HTML')).toBe('.html');
    expect(extensionFromPath('foo.tar.gz')).toBe('.gz');
    expect(extensionFromPath('no-extension')).toBe('');
  });
});

describe('chat-file-links / isSidebarPreviewFile', () => {
  it('matches markdown / text / data / image / pdf extensions', () => {
    expect(isSidebarPreviewFile('notes.md')).toBe(true);
    expect(isSidebarPreviewFile('README.markdown')).toBe(true);
    expect(isSidebarPreviewFile('README.txt')).toBe(true);
    expect(isSidebarPreviewFile('package.json')).toBe(true);
    expect(isSidebarPreviewFile('.yaml')).toBe(true);
    expect(isSidebarPreviewFile('config.yml')).toBe(true);
    expect(isSidebarPreviewFile('cover.png')).toBe(true);
    expect(isSidebarPreviewFile('photo.jpg')).toBe(true);
    expect(isSidebarPreviewFile('chart.svg')).toBe(true);
    expect(isSidebarPreviewFile('manual.pdf')).toBe(true);
  });

  it('matches source-code extensions so they route to the preview panel', () => {
    // Web / scripting
    expect(isSidebarPreviewFile('app.ts')).toBe(true);
    expect(isSidebarPreviewFile('Card.tsx')).toBe(true);
    expect(isSidebarPreviewFile('index.js')).toBe(true);
    expect(isSidebarPreviewFile('module.mjs')).toBe(true);
    expect(isSidebarPreviewFile('style.css')).toBe(true);
    expect(isSidebarPreviewFile('theme.scss')).toBe(true);
    expect(isSidebarPreviewFile('App.vue')).toBe(true);
    // Systems / compiled
    expect(isSidebarPreviewFile('server.py')).toBe(true);
    expect(isSidebarPreviewFile('main.go')).toBe(true);
    expect(isSidebarPreviewFile('lib.rs')).toBe(true);
    expect(isSidebarPreviewFile('Foo.kt')).toBe(true);
    expect(isSidebarPreviewFile('query.sql')).toBe(true);
    expect(isSidebarPreviewFile('build.sh')).toBe(true);
  });

  it('rejects extensions outside the preview allow-list', () => {
    expect(isSidebarPreviewFile('archive.zip')).toBe(false);
    expect(isSidebarPreviewFile('binary.exe')).toBe(false);
    expect(isSidebarPreviewFile('page.docx')).toBe(false); // → Office panel
    expect(isSidebarPreviewFile('site.html')).toBe(false); // → browser panel
    expect(isSidebarPreviewFile('noext')).toBe(false);
  });
});

describe('chat-file-links / openLocalArtifactTarget', () => {
  // Stub the bridge so jsdom's `window.open` doesn't actually navigate
  // and so we can observe which event the helper dispatches for a given
  // input path.
  type Detail = { url?: string; filePath?: string; workingDirectory?: string | null };
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

  it('routes .html to duya:open-browser-panel', () => {
    openLocalArtifactTarget('E:\\projects\\page.html');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-browser-panel');
    expect(dispatched[0].detail.url).toBe('E:\\projects\\page.html');
  });

  it('routes .html to duya:open-browser-panel on Unix', () => {
    openLocalArtifactTarget('/Users/duya/projects/page.html');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-browser-panel');
    expect(dispatched[0].detail.url).toBe('/Users/duya/projects/page.html');
  });

  it('routes .docx to duya:open-office-panel', () => {
    openLocalArtifactTarget('E:\\reports\\plan.docx');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-office-panel');
    expect(dispatched[0].detail.filePath).toBe('E:\\reports\\plan.docx');
  });

  it('routes .docx to duya:open-office-panel on Unix', () => {
    openLocalArtifactTarget('/Users/duya/reports/plan.docx');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-office-panel');
    expect(dispatched[0].detail.filePath).toBe('/Users/duya/reports/plan.docx');
  });

  it('routes source code files to duya:open-file-preview-panel', () => {
    openLocalArtifactTarget('E:\\src\\app.ts');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('E:\\src\\app.ts');
  });

  it('routes source code files to duya:open-file-preview-panel on Unix', () => {
    openLocalArtifactTarget('/Users/duya/src/app.ts');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('/Users/duya/src/app.ts');
  });

  it('routes markdown to duya:open-file-preview-panel', () => {
    openLocalArtifactTarget('E:\\docs\\README.md');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('E:\\docs\\README.md');
  });

  it('routes markdown to duya:open-file-preview-panel on Unix', () => {
    openLocalArtifactTarget('/Users/duya/docs/_整理方案.md');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.filePath).toBe('/Users/duya/docs/_整理方案.md');
  });

  it('falls through to openLocalFileTarget for non-previewable extensions', () => {
    // Stub window.electronAPI.shell.openPath so we don't try to launch a
    // real archive viewer; then assert the helper falls through (no
    // side-panel event, but a shell.openPath call).
    const shellOpen = vi.fn().mockResolvedValue('');
    (window as unknown as { electronAPI: { shell: { openPath: typeof shellOpen } } }).electronAPI = {
      shell: { openPath: shellOpen },
    };
    openLocalArtifactTarget('E:\\build\\app.zip');
    expect(dispatched).toHaveLength(0);
    expect(shellOpen).toHaveBeenCalledWith('E:\\build\\app.zip');
  });

  it('falls through to openLocalFileTarget for non-previewable extensions on Unix', () => {
    const shellOpen = vi.fn().mockResolvedValue('');
    (window as unknown as { electronAPI: { shell: { openPath: typeof shellOpen } } }).electronAPI = {
      shell: { openPath: shellOpen },
    };
    openLocalArtifactTarget('/Users/duya/build/app.zip');
    expect(dispatched).toHaveLength(0);
    expect(shellOpen).toHaveBeenCalledWith('/Users/duya/build/app.zip');
  });

  it('uses cwd as preview root when the file is inside the working directory', () => {
    openLocalArtifactTarget('E:\\project\\src\\app.ts', 'E:\\project');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.workingDirectory).toBe('E:\\project');
  });

  it('uses cwd as preview root when the file is inside the working directory on Unix', () => {
    openLocalArtifactTarget('/Users/duya/project/src/app.ts', '/Users/duya/project');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.workingDirectory).toBe('/Users/duya/project');
  });

  it('falls back to the file directory as preview root when outside cwd', () => {
    openLocalArtifactTarget('E:\\other-project\\data.json', 'E:\\project');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.workingDirectory).toBe('E:\\other-project');
  });

  it('falls back to the file directory as preview root when outside cwd on Unix', () => {
    openLocalArtifactTarget('/Users/other-project/data.json', '/Users/duya/project');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].event).toBe('duya:open-file-preview-panel');
    expect(dispatched[0].detail.workingDirectory).toBe('/Users/other-project');
  });
});