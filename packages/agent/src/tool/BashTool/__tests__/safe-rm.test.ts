/**
 * safe-rm tests (plan 554): the conservative plain-`rm` parser and the
 * PowerShell recycle-script builder. The PowerShell execution itself is
 * environment-dependent and covered by the BashTool integration path.
 */

import { describe, it, expect } from 'vitest';
import { buildRecycleScript, parsePlainRmCommand } from '../safe-rm.js';

describe('parsePlainRmCommand', () => {
  it('accepts plain rm with flags and targets', () => {
    expect(parsePlainRmCommand('rm file.txt')).toEqual({ targets: ['file.txt'] });
    expect(parsePlainRmCommand('rm -rf build dist')).toEqual({
      targets: ['build', 'dist'],
    });
    expect(parsePlainRmCommand('rm -r -f -- ./a.txt b.log')).toEqual({
      targets: ['./a.txt', 'b.log'],
    });
  });

  it('handles quoted paths with spaces', () => {
    expect(parsePlainRmCommand("rm 'my file.txt'")).toEqual({
      targets: ['my file.txt'],
    });
    expect(parsePlainRmCommand('rm "my file.txt"')).toEqual({
      targets: ['my file.txt'],
    });
  });

  it('rejects anything that is not a plain top-level rm', () => {
    expect(parsePlainRmCommand('echo rm file.txt')).toBeNull();
    expect(parsePlainRmCommand('rm file.txt && echo done')).toBeNull();
    expect(parsePlainRmCommand('rm a | b')).toBeNull();
    expect(parsePlainRmCommand('rm a; rm b')).toBeNull();
    expect(parsePlainRmCommand('rm a > out.log')).toBeNull();
    expect(parsePlainRmCommand('rm $(pwd)/file')).toBeNull();
    expect(parsePlainRmCommand('git rm file.txt')).toBeNull();
    expect(parsePlainRmCommand('')).toBeNull();
    expect(parsePlainRmCommand('rm')).toBeNull(); // no targets
    expect(parsePlainRmCommand('rm -rf')).toBeNull(); // flags only
    expect(parsePlainRmCommand("rm 'unterminated")).toBeNull();
  });

  it('rejects glob patterns (recycle bin cannot expand them)', () => {
    expect(parsePlainRmCommand('rm *.log')).toBeNull();
    expect(parsePlainRmCommand('rm build/*.tmp')).toBeNull();
    expect(parsePlainRmCommand('rm file?.txt')).toBeNull();
    expect(parsePlainRmCommand('rm [abc].txt')).toBeNull();
  });
});

describe('buildRecycleScript', () => {
  it('emits a guarded DeleteFile/DeleteDirectory per path', () => {
    const script = buildRecycleScript(['C:\\tmp\\a.txt']);
    expect(script).toContain('Test-Path -LiteralPath \'C:\\tmp\\a.txt\' -PathType Leaf');
    expect(script).toContain('DeleteFile');
    expect(script).toContain('DeleteDirectory');
    expect(script).toContain("'SendToRecycleBin'");
    expect(script).toContain('MISSING:');
  });

  it('escapes single quotes in paths', () => {
    const script = buildRecycleScript(["C:\\tmp\\bob's file.txt"]);
    expect(script).toContain("'C:\\tmp\\bob''s file.txt'");
  });
});
