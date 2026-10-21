import { describe, expect, it } from 'vitest';

import {
  extensionToHighlightLanguage,
  isCommentSubmitShortcut,
} from './code-review-code-viewer';

describe('extensionToHighlightLanguage', () => {
  it('maps known extensions to shiki languages', () => {
    expect(extensionToHighlightLanguage('src/app/Panel.tsx')).toBe('tsx');
    expect(extensionToHighlightLanguage('index.js')).toBe('javascript');
    expect(extensionToHighlightLanguage('README.md')).toBe('markdown');
    expect(extensionToHighlightLanguage('run.ps1')).toBe('powershell');
  });

  it('falls back to text for unknown or extension-less names', () => {
    expect(extensionToHighlightLanguage('archive.zxv9')).toBe('text');
    expect(extensionToHighlightLanguage('LICENSE')).toBe('text');
  });
});

describe('isCommentSubmitShortcut', () => {
  it('accepts Ctrl+Enter on non-Apple platforms', () => {
    expect(
      isCommentSubmitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false }, { platform: 'Win32' }),
    ).toBe(true);
  });

  it('accepts Cmd+Enter and rejects Ctrl+Enter on Apple platforms', () => {
    expect(
      isCommentSubmitShortcut({ key: 'Enter', ctrlKey: false, metaKey: true }, { platform: 'MacIntel' }),
    ).toBe(true);
    expect(
      isCommentSubmitShortcut({ key: 'Enter', ctrlKey: true, metaKey: false }, { platform: 'MacIntel' }),
    ).toBe(false);
  });

  it('rejects other keys', () => {
    expect(
      isCommentSubmitShortcut({ key: 'a', ctrlKey: true, metaKey: false }, { platform: 'Win32' }),
    ).toBe(false);
  });
});
