import { describe, expect, it } from 'vitest';

import {
  basenameFromPath,
  dedupeByContainment,
  isPathAncestorOrSame,
  isPathInside,
  normalizePath,
} from '../projectPaths';

describe('isPathInside', () => {
  it('treats target strictly inside root as descendant', () => {
    expect(isPathInside('E:/Projects/duya/docs', 'E:/Projects/duya')).toBe(true);
  });

  it('returns false when target equals root (siblings, not inside)', () => {
    expect(isPathInside('E:/Projects/duya', 'E:/Projects/duya')).toBe(false);
  });

  it('returns false for prefix collision (duya-extra vs duya)', () => {
    // E:/Projects/duya-extra must NOT be inside E:/Projects/duya.
    expect(isPathInside('E:/Projects/duya-extra', 'E:/Projects/duya')).toBe(false);
  });

  it('treats Windows backslash and forward slash as equivalent', () => {
    expect(isPathInside('E:\\Projects\\duya\\docs', 'E:/Projects/duya')).toBe(true);
    expect(isPathInside('E:/Projects/duya/docs', 'E:\\Projects\\duya')).toBe(true);
  });

  it('is case-insensitive on Windows', () => {
    expect(isPathInside('e:/projects/duya/docs', 'E:/Projects/duya')).toBe(true);
    expect(isPathInside('E:/PROJECTS/DUYA/DOCS', 'e:/projects/duya')).toBe(true);
  });

  it('is case-sensitive on POSIX', () => {
    expect(isPathInside('/home/User/notes', '/home/user')).toBe(false);
    expect(isPathInside('/home/user/Notes', '/home/user')).toBe(true);
  });

  it('strips trailing separators before comparing', () => {
    expect(isPathInside('E:/Projects/duya/docs/', 'E:/Projects/duya/')).toBe(true);
    expect(isPathInside('E:/Projects/duya/', 'E:/Projects/duya/')).toBe(false);
  });

  it('handles UNC paths (\\nas\\share\\repo\\src)', () => {
    expect(isPathInside('\\\\nas\\share\\repo\\src', '\\\\nas\\share\\repo')).toBe(true);
    expect(isPathInside('\\\\nas\\share\\repo', '\\\\nas\\share\\repo')).toBe(false);
    // Different share, same host: not inside.
    expect(isPathInside('\\\\nas\\other\\repo', '\\\\nas\\share')).toBe(false);
  });

  it('handles POSIX root (single slash)', () => {
    expect(isPathInside('/etc/hosts', '/etc')).toBe(true);
    // `/etc` is inside `/`, so descendants of root are inside root.
    expect(isPathInside('/etc', '/')).toBe(true);
    expect(isPathInside('/foo', '/')).toBe(true);
  });

  it('throws on empty inputs (caller should validate upstream)', () => {
    expect(() => isPathInside('', 'E:/x')).toThrow();
    expect(() => isPathInside('E:/x', '')).toThrow();
  });
});

describe('isPathAncestorOrSame', () => {
  it('returns true when target equals root', () => {
    expect(isPathAncestorOrSame('E:/Projects/duya', 'E:/Projects/duya')).toBe(true);
  });

  it('returns true when target is a strict ancestor of root', () => {
    expect(isPathAncestorOrSame('E:/Projects/duya', 'E:/Projects/duya/docs')).toBe(true);
    expect(isPathAncestorOrSame('E:/Projects/duya', 'E:/Projects/duya/docs/exec-plans')).toBe(true);
  });

  it('returns false when target is a descendant of root', () => {
    expect(isPathAncestorOrSame('E:/Projects/duya/docs', 'E:/Projects/duya')).toBe(false);
  });

  it('returns false for unrelated paths', () => {
    expect(isPathAncestorOrSame('E:/Projects/duya-website', 'E:/Projects/duya')).toBe(false);
  });

  it('is case-insensitive on Windows', () => {
    expect(isPathAncestorOrSame('e:/projects/duya', 'E:/Projects/duya/docs')).toBe(true);
  });

  it('is case-sensitive on POSIX', () => {
    expect(isPathAncestorOrSame('/home/User', '/home/user/notes')).toBe(false);
    expect(isPathAncestorOrSame('/home/user', '/home/user/Notes')).toBe(true);
  });
});

describe('dedupeByContainment', () => {
  it('returns empty array for empty input', () => {
    expect(dedupeByContainment([])).toEqual([]);
  });

  it('returns single-element array unchanged (modulo trailing separators + Win case)', () => {
    expect(dedupeByContainment(['E:/Projects/duya'])).toEqual(['e:/projects/duya']);
    expect(dedupeByContainment(['E:/Projects/duya/'])).toEqual(['e:/projects/duya']);
  });

  it('keeps ancestors, drops descendants (plan 530 §3.2 example)', () => {
    const input = [
      'E:/Projects/duya',
      'E:/Projects/duya/docs',
      'E:/Projects/duya/docs/exec-plans',
      'E:/Projects/duya-website',
    ];
    expect(dedupeByContainment(input)).toEqual([
      'e:/projects/duya',
      'e:/projects/duya-website',
    ]);
  });

  it('keeps siblings that share a parent but are not nested', () => {
    const input = [
      'E:/Projects/duya-website',
      'E:/Projects/duya-marketplace',
      'E:/Papers/duya-research',
    ];
    expect(dedupeByContainment(input)).toEqual([
      'e:/papers/duya-research',
      'e:/projects/duya-marketplace',
      'e:/projects/duya-website',
    ]);
  });

  it('drops exact duplicates, keeping the first occurrence', () => {
    const input = [
      'E:/Projects/duya',
      'e:/projects/duya', // Windows-case duplicate of the first
      'E:/Projects/duya-website',
    ];
    // Windows case-insensitive duplicate: both normalize to
    // 'e:/projects/duya', the first wins and the second is dropped.
    const result = dedupeByContainment(input);
    expect(result).toEqual(['e:/projects/duya', 'e:/projects/duya-website']);
  });

  it('treats POSIX duplicates as distinct (case-sensitive)', () => {
    const input = ['/home/user/notes', '/home/user/Notes'];
    // Neither contains the other; both kept.
    expect(dedupeByContainment(input)).toEqual([
      '/home/user/Notes',
      '/home/user/notes',
    ]);
  });

  it('handles UNC paths and POSIX paths in the same input', () => {
    const input = [
      '\\\\nas\\share\\repo',
      '\\\\nas\\share\\repo\\src',
      '/home/user/notes',
      '/home/user/notes/draft',
    ];
    // UNC is treated as Win: lowercase + backslash → forward slash.
    // POSIX paths keep their case + forward slashes.
    expect(dedupeByContainment(input)).toEqual([
      '//nas/share/repo',
      '/home/user/notes',
    ]);
  });

  it('skips empty strings (does not throw)', () => {
    expect(dedupeByContainment(['', 'E:/Projects/duya', ''])).toEqual([
      'e:/projects/duya',
    ]);
  });

  it('produces stable sort order regardless of input order', () => {
    const a = ['E:/b', 'E:/a', 'E:/a/sub'];
    const b = ['E:/a/sub', 'E:/a', 'E:/b'];
    expect(dedupeByContainment(a)).toEqual(dedupeByContainment(b));
  });

  it('does not lose a non-descendant that shares a prefix', () => {
    // duya-extra vs duya: must both appear.
    const input = ['E:/Projects/duya', 'E:/Projects/duya-extra'];
    expect(dedupeByContainment(input)).toEqual([
      'e:/projects/duya',
      'e:/projects/duya-extra',
    ]);
  });

  it('handles a long chain of nested paths', () => {
    const input = [
      'E:/Projects/duya/docs/exec-plans/active',
      'E:/Projects/duya/docs/exec-plans',
      'E:/Projects/duya/docs',
      'E:/Projects/duya',
    ];
    expect(dedupeByContainment(input)).toEqual(['e:/projects/duya']);
  });

  it('dedupes when ancestors appear AFTER descendants in input order', () => {
    // The dedupe algorithm must catch the case where a shorter ancestor
    // is presented AFTER its longer descendants.
    const input = [
      'E:/Projects/duya/docs',
      'E:/Projects/duya/docs/exec-plans',
      'E:/Projects/duya',
    ];
    expect(dedupeByContainment(input)).toEqual(['e:/projects/duya']);
  });
});

describe('normalizePath', () => {
  it('strips trailing forward slashes', () => {
    expect(normalizePath('E:/Projects/duya/')).toBe('E:/Projects/duya');
    expect(normalizePath('/home/user/notes///')).toBe('/home/user/notes');
  });

  it('strips trailing backslashes on Windows paths', () => {
    expect(normalizePath('E:\\Projects\\duya\\')).toBe('E:\\Projects\\duya');
  });

  it('returns empty string unchanged', () => {
    expect(normalizePath('')).toBe('');
  });

  it('leaves non-trailing separators alone', () => {
    expect(normalizePath('E:/Projects/duya/docs')).toBe('E:/Projects/duya/docs');
  });
});

describe('basenameFromPath', () => {
  it('returns last segment for forward-slash paths', () => {
    expect(basenameFromPath('E:/Projects/duya')).toBe('duya');
    expect(basenameFromPath('/home/user/notes')).toBe('notes');
  });

  it('strips trailing separators before extracting', () => {
    expect(basenameFromPath('E:/Projects/duya/')).toBe('duya');
    expect(basenameFromPath('/home/user/')).toBe('user');
  });

  it('returns drive label for Windows root volume', () => {
    expect(basenameFromPath('E:/')).toBe('E:');
  });

  it('extracts share name from UNC paths with no subpath', () => {
    expect(basenameFromPath('\\\\nas\\repo')).toBe('repo');
  });

  it('extracts last subpath segment from UNC paths with subpath', () => {
    expect(basenameFromPath('\\\\nas\\repo\\src\\index.ts')).toBe('index.ts');
  });

  it('handles mixed separators on Windows', () => {
    expect(basenameFromPath('E:\\Projects/duya\\docs')).toBe('docs');
  });

  it('returns empty string for empty input', () => {
    expect(basenameFromPath('')).toBe('');
  });
});