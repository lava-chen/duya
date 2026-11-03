import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPromptPresets, writePromptPresets } from '../presets.js';

const directories: string[] = [];
function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'duya-presets-'));
  directories.push(directory);
  return join(directory, 'nested', 'presets.json');
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('prompt preset storage', () => {
  it('creates a private file and round-trips valid named prompts', () => {
    const file = tempFile();
    writePromptPresets({ summarize: 'Summarize this codebase', '设计稿': 'Review this design' }, file);
    expect(readPromptPresets(file)).toEqual({ summarize: 'Summarize this codebase', '设计稿': 'Review this design' });
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('Summarize this codebase');
  });

  it('ignores malformed files and invalid entries', () => {
    const file = tempFile();
    writePromptPresets({ '../escape': 'bad', okay: 'good' }, file);
    expect(readPromptPresets(file)).toEqual({ okay: 'good' });
    writePromptPresets({} as Record<string, string>, `${file}.missing`);
    expect(readPromptPresets(`${file}.missing`)).toEqual({});
  });
});
