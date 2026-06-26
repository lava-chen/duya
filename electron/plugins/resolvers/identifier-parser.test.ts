import { describe, it, expect } from 'vitest';
import { parsePluginIdentifier } from './identifier-parser';

describe('parsePluginIdentifier', () => {
  describe('built-in plugins', () => {
    it('parses bare plugin name as builtin-directory', () => {
      const result = parsePluginIdentifier('literature');
      expect(result.type).toBe('builtin-directory');
      expect(result.identifier).toBe('literature');
      expect(result.marketplace).toBe('builtin');
    });

    it('parses explicit @builtin', () => {
      const result = parsePluginIdentifier('literature@builtin');
      expect(result.type).toBe('builtin-directory');
      expect(result.identifier).toBe('literature@builtin');
      expect(result.marketplace).toBe('builtin');
    });
  });

  describe('github plugins', () => {
    it('parses plugin@github', () => {
      const result = parsePluginIdentifier('code-reviewer@github');
      expect(result.type).toBe('github');
      expect(result.marketplace).toBe('github');
    });

    it('parses github.com URL', () => {
      const result = parsePluginIdentifier('https://github.com/user/repo');
      expect(result.type).toBe('github');
    });

    it('parses github URL with subdir', () => {
      const result = parsePluginIdentifier('https://github.com/user/repo/tree/main/plugins/my-plugin');
      expect(result.type).toBe('github');
    });
  });

  describe('npm plugins', () => {
    it('parses plugin@npm', () => {
      const result = parsePluginIdentifier('formatter@npm');
      expect(result.type).toBe('npm');
      expect(result.marketplace).toBe('npm');
    });

    it('parses scoped npm package', () => {
      const result = parsePluginIdentifier('@scope/package@npm');
      expect(result.type).toBe('npm');
      expect(result.marketplace).toBe('npm');
    });
  });

  describe('local path plugins', () => {
    it('parses plugin@local', () => {
      const result = parsePluginIdentifier('my-plugin@local');
      expect(result.type).toBe('local-path');
      expect(result.marketplace).toBe('local');
    });

    it('parses absolute path (Unix)', () => {
      if (process.platform !== 'win32') {
        const result = parsePluginIdentifier('/home/user/my-plugin');
        expect(result.type).toBe('local-path');
      }
    });

    it('parses relative path', () => {
      const result = parsePluginIdentifier('../my-plugin');
      expect(result.type).toBe('local-path');
    });
  });

  describe('URL detection', () => {
    it('detects https:// URL as url-zip', () => {
      const result = parsePluginIdentifier('https://example.com/plugin.zip');
      expect(result.type).toBe('url-zip');
    });

    it('detects HTTPS git URL', () => {
      const result = parsePluginIdentifier('https://gitlab.com/user/repo.git');
      expect(result.type).toBe('https-git');
    });

    it('detects git+ protocol', () => {
      const result = parsePluginIdentifier('git+https://example.com/repo.git');
      expect(result.type).toBe('https-git');
    });
  });

  describe('version handling', () => {
    it('parses version from fragment', () => {
      const result = parsePluginIdentifier('formatter@npm#1.2.3');
      expect(result.type).toBe('npm');
      expect(result.identifier).toBe('formatter@npm#1.2.3');
    });
  });

  describe('unknown marketplace', () => {
    it('falls back to github for unknown marketplaces', () => {
      const result = parsePluginIdentifier('plugin@unknown');
      expect(result.type).toBe('github');
    });
  });
});