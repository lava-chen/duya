/**
 * security.test.ts
 *
 * Verifies path safety checks (UNC, device files) and binary detection
 * (magic-byte signatures + non-printable heuristic).
 */

import { describe, it, expect } from 'vitest';
import {
  isUNCPath,
  isBlockedDevicePath,
  detectBinarySignature,
  looksBinaryByHeuristic,
  BLOCKED_DEVICE_PATHS,
} from '../security.js';

describe('isUNCPath', () => {
  it('rejects Windows UNC paths', () => {
    expect(isUNCPath('\\\\evil-share\\file.txt')).toBe(true);
    expect(isUNCPath('//server/share')).toBe(true);
    expect(isUNCPath('unc\\foo')).toBe(true);
    expect(isUNCPath('smb://server/share')).toBe(true);
  });

  it('accepts Unix absolute paths and Windows drive letters', () => {
    expect(isUNCPath('/usr/local/bin')).toBe(false);
    expect(isUNCPath('/c/Users/foo')).toBe(false);
    expect(isUNCPath('C:\\Users\\foo')).toBe(false);
    expect(isUNCPath('./relative/path')).toBe(false);
    expect(isUNCPath('foo.txt')).toBe(false);
  });
});

describe('isBlockedDevicePath', () => {
  it('flags known hang / infinite-output devices', () => {
    for (const p of BLOCKED_DEVICE_PATHS) {
      expect(isBlockedDevicePath(p)).toBe(true);
    }
  });

  it('flags /proc/self/fd/0-2', () => {
    expect(isBlockedDevicePath('/proc/self/fd/0')).toBe(true);
    expect(isBlockedDevicePath('/proc/self/fd/1')).toBe(true);
    expect(isBlockedDevicePath('/proc/self/fd/2')).toBe(true);
    expect(isBlockedDevicePath('/proc/12345/fd/0')).toBe(true);
  });

  it('does NOT flag safe devices', () => {
    expect(isBlockedDevicePath('/dev/null')).toBe(false);
    expect(isBlockedDevicePath('/dev/sda')).toBe(false);
    expect(isBlockedDevicePath('/etc/passwd')).toBe(false);
    expect(isBlockedDevicePath('/home/user/file.txt')).toBe(false);
  });

  it('does NOT flag /proc paths that are not stdio fds', () => {
    expect(isBlockedDevicePath('/proc/cmdline')).toBe(false);
    expect(isBlockedDevicePath('/proc/self/status')).toBe(false);
    expect(isBlockedDevicePath('/proc/12345/maps')).toBe(false);
  });
});

describe('detectBinarySignature', () => {
  function bytes(...values: number[]): Uint8Array {
    return new Uint8Array(values);
  }

  it('detects ELF, PE, Mach-O', () => {
    expect(detectBinarySignature(bytes(0x7f, 0x45, 0x4c, 0x46))).toMatch(/ELF/);
    expect(detectBinarySignature(bytes(0x4d, 0x5a))).toMatch(/PE/);
    expect(detectBinarySignature(bytes(0xfe, 0xed, 0xfa, 0xce))).toMatch(/Mach-O/);
  });

  it('detects common archives', () => {
    expect(detectBinarySignature(bytes(0x50, 0x4b, 0x03, 0x04))).toMatch(/ZIP/);
    expect(detectBinarySignature(bytes(0x1f, 0x8b))).toMatch(/GZIP/);
    expect(detectBinarySignature(bytes(0x42, 0x5a, 0x68))).toMatch(/BZIP2/);
    expect(detectBinarySignature(bytes(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00))).toMatch(/XZ/);
  });

  it('detects image formats', () => {
    expect(detectBinarySignature(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toMatch(/PNG/);
    expect(detectBinarySignature(bytes(0xff, 0xd8, 0xff))).toMatch(/JPEG/);
    expect(detectBinarySignature(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toMatch(/GIF/);
  });

  it('returns null for plain text', () => {
    const text = new TextEncoder().encode('hello world\nline 2');
    expect(detectBinarySignature(text)).toBeNull();
  });

  it('returns null for empty / too-short buffers', () => {
    expect(detectBinarySignature(new Uint8Array())).toBeNull();
    expect(detectBinarySignature(bytes(0x7f))).toBeNull();
  });

  it('detects SQLite and WASM (exotic but valid formats)', () => {
    expect(detectBinarySignature(bytes(0x53, 0x51, 0x4c, 0x69, 0x74, 0x65))).toMatch(/SQLite/);
    expect(detectBinarySignature(bytes(0x00, 0x61, 0x73, 0x6d))).toMatch(/WebAssembly/);
  });
});

describe('looksBinaryByHeuristic', () => {
  it('flags buffers with high non-printable ratio', () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xab, 0xcd, 0xef, 0x12, 0x34, 0x56]);
    expect(looksBinaryByHeuristic(binary)).toBe(true);
  });

  it('does NOT flag normal ASCII text', () => {
    const text = new TextEncoder().encode('function foo() {\n  return 42;\n}\n'.repeat(5));
    expect(looksBinaryByHeuristic(text)).toBe(false);
  });

  it('tolerates common whitespace and tab characters', () => {
    const text = new TextEncoder().encode('a\tb\tc\n\nd\re\tf');
    expect(looksBinaryByHeuristic(text)).toBe(false);
  });

  it('tolerates UTF-8 multibyte content (high-bit bytes)', () => {
    // "你好世界" in UTF-8
    const utf8 = new TextEncoder().encode('你好世界');
    expect(looksBinaryByHeuristic(utf8)).toBe(false);
  });

  it('returns false for empty buffer (not enough evidence)', () => {
    expect(looksBinaryByHeuristic(new Uint8Array())).toBe(false);
  });
});
