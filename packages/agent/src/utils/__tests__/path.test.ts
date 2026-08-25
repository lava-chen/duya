import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { expandPath, looksLikePosixDrivePath, posixPathToWindowsPath } from '../path.js';

describe('posixPathToWindowsPath', () => {
  it('converts MSYS2/Git Bash drive paths', () => {
    expect(posixPathToWindowsPath('/e/Projects/duya')).toBe('E:\\Projects\\duya');
    expect(posixPathToWindowsPath('/e')).toBe('E:\\');
    expect(posixPathToWindowsPath('/c/Users/foo')).toBe('C:\\Users\\foo');
  });

  it('converts WSL /mnt/ drive paths', () => {
    expect(posixPathToWindowsPath('/mnt/e/Projects/duya')).toBe('E:\\Projects\\duya');
    expect(posixPathToWindowsPath('/mnt/d')).toBe('D:\\');
  });

  it('converts Cygwin /cygdrive/ paths', () => {
    expect(posixPathToWindowsPath('/cygdrive/e/x')).toBe('E:\\x');
    expect(posixPathToWindowsPath('/cygdrive/c')).toBe('C:\\');
  });

  it('converts UNC paths to backslash form', () => {
    expect(posixPathToWindowsPath('//server/share')).toBe('\\\\server\\share');
  });

  it('flips separators for already-Windows paths', () => {
    expect(posixPathToWindowsPath('C:/temp/x')).toBe('C:\\temp\\x');
  });

  it('falls through to separator flip for non-drive POSIX paths', () => {
    // Windows resolves a leading "/" against the current drive root, so
    // flipping separators is the faithful transformation for /usr/bin etc.
    expect(posixPathToWindowsPath('/usr/bin')).toBe('\\usr\\bin');
  });
});

describe('looksLikePosixDrivePath', () => {
  it('accepts drive-letter POSIX forms', () => {
    expect(looksLikePosixDrivePath('/e/Projects')).toBe(true);
    expect(looksLikePosixDrivePath('/e')).toBe(true);
    expect(looksLikePosixDrivePath('/E/')).toBe(true);
    expect(looksLikePosixDrivePath('/mnt/e/work')).toBe(true);
    expect(looksLikePosixDrivePath('/cygdrive/d/x')).toBe(true);
  });

  it('rejects non-drive shapes', () => {
    expect(looksLikePosixDrivePath('/usr/bin')).toBe(false);
    expect(looksLikePosixDrivePath('//server/share')).toBe(false);
    expect(looksLikePosixDrivePath('C:\\repo')).toBe(false);
    expect(looksLikePosixDrivePath('relative/path')).toBe(false);
    expect(looksLikePosixDrivePath('')).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('expandPath on win32', () => {
  it('converts Git Bash paths to native form', () => {
    expect(expandPath('/e/Projects/duya')).toBe('E:\\Projects\\duya');
  });

  it('converts WSL paths to native form', () => {
    expect(expandPath('/mnt/e/Projects/duya')).toBe('E:\\Projects\\duya');
  });

  it('converts Cygwin paths (previously blocked by the trigger regex)', () => {
    expect(expandPath('/cygdrive/e/Projects/duya')).toBe('E:\\Projects\\duya');
  });

  it('leaves genuine POSIX paths to Windows resolution', () => {
    expect(expandPath('/usr/bin')).toBe('\\usr\\bin');
  });

  it('expands ~ to the home directory', () => {
    expect(expandPath('~')).toBe(homedir());
  });

  it('resolves relative paths against baseDir', () => {
    expect(expandPath('sub/x', 'E:\\repo')).toBe('E:\\repo\\sub\\x');
  });
});
