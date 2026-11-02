/**
 * The workspace-relative path guard.
 *
 * ## What this guards
 *
 * `SessionWorkspace.relativePath` used to be a plain `string` while the type
 * beside it claimed that a path "cannot express `..`" and therefore cannot
 * address a directory outside its workspace. A string expresses `..` perfectly
 * well, so the comment described an intention the type did not enforce.
 *
 * The guard has two halves and the test needs both:
 *
 * - The RUNTIME half is `toSessionRelativePath`, which refuses a path that
 *   leaves the root. This is the part that actually stops an escape.
 * - The COMPILE-TIME half is the brand, so a raw string cannot be passed
 *   where a checked path is expected. That is what
 *   `string extends SessionRelativePath` asserts below.
 *
 * ## Why the odd cases are in here
 *
 * The Windows quirks are not decoration. On Windows the filesystem strips
 * trailing dots and spaces from a path segment, so `".. "` resolves as the
 * parent directory even though it is not the string `".."`. A guard that only
 * compared against `".."` would wave it through. The same is why both
 * separators are accepted: a path that is safe with `/` must not become
 * unsafe with `\`, and vice versa.
 */

import { describe, expect, it } from 'vitest';
import {
  isSessionRelativePathSafe,
  sessionRelativePathRejection,
  toSessionRelativePath,
  type SessionRelativePath,
} from '../src/session/index.js';

/**
 * A compile-time assertion that the branded type is still a brand.
 *
 * If the brand is removed, `string extends SessionRelativePath` becomes
 * true, the type becomes `never`, and this assignment stops compiling.
 */
type RelativePathMustNotBePlainString = string extends SessionRelativePath ? never : true;
const relativePathIsNotPlainString: RelativePathMustNotBePlainString = true;

describe('the workspace relative path guard', () => {
  it('is not a plain string', () => {
    expect(relativePathIsNotPlainString).toBe(true);
  });

  it('accepts paths that stay inside the root', () => {
    for (const safe of ['', '.', './src', 'src', 'src/app', 'src\\app', 'a.b.c', 'a..', '. ']) {
      expect(sessionRelativePathRejection(safe), `expected ${JSON.stringify(safe)} to be safe`).toBeNull();
      expect(isSessionRelativePathSafe(safe)).toBe(true);
      expect(toSessionRelativePath(safe)).toBe(safe);
    }
  });

  it('refuses a parent segment', () => {
    for (const escaping of ['..', '../etc', 'a/../../b', 'a\\..\\b', 'src/..']) {
      expect(sessionRelativePathRejection(escaping)).toBe('parent_segment');
      expect(isSessionRelativePathSafe(escaping)).toBe(false);
    }
  });

  it('refuses a segment that only Windows would turn into one', () => {
    // Windows strips trailing dots and spaces from a segment, so ".. " and
    // ".. ." both reach the filesystem as the parent directory, and "..."
    // collapses to an empty name.
    for (const escaping of ['.. ', '.. .', 'a/.. /b', 'a\\..\\.. ', '...']) {
      expect(sessionRelativePathRejection(escaping), `expected ${JSON.stringify(escaping)} to be refused`).toBe(
        'parent_segment',
      );
    }
  });

  it('refuses an absolute path', () => {
    for (const absolute of ['/etc/passwd', '\\windows\\system32', 'C:\\Users', 'c:/Users', '//server/share']) {
      expect(sessionRelativePathRejection(absolute)).toBe('absolute_path');
      expect(isSessionRelativePathSafe(absolute)).toBe(false);
    }
  });

  it('refuses a control character', () => {
    expect(sessionRelativePathRejection('a\u0000b')).toBe('control_character');
    expect(sessionRelativePathRejection('a\nb')).toBe('control_character');
    expect(isSessionRelativePathSafe('a\u0000b')).toBe(false);
  });

  it('throws rather than returning a sanitised path', () => {
    // A sanitised path would point somewhere the caller did not ask for, and
    // the caller would never know.
    expect(() => toSessionRelativePath('../etc')).toThrow(/parent_segment/);
    expect(() => toSessionRelativePath('/etc')).toThrow(/absolute_path/);
  });
});
