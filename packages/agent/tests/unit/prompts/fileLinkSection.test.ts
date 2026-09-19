/**
 * Locks in the simplified file-link rule in `finalAnswer` so future drift
 * (adding back the bare-filename / relative-path fallback, or letting the
 * Windows example leak an `/abs/` placeholder) is caught in CI.
 *
 * Mirrors the user-reported failure modes:
 *   1. Model emits `E:/...` absolute drive path while chat cwd is elsewhere
 *      → was coached by the old "If you do not know the absolute path, use a
 *      relative path or bare filename" rule. New rule tells the model to
 *      say the name in prose instead.
 *   2. Model emits `docs/foo.md` (relative) → same root cause.
 *   3. Model emits `/abs/E:/...` hybrid on Windows → Windows example must
 *      forbid `/abs/` prefix.
 */
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { HbsPromptSystem } from '../../../src/prompts/hbs/HbsPromptSystem.js';
import { BOT_BASIC_SYSTEM_PROMPT } from '../../../src/prompts/bot/basicPrompt.js';
import type { PromptContext } from '../../../src/prompts/types.js';

const hbs = new HbsPromptSystem({
  assetsRoot: resolve(__dirname, '../../../src/prompts/assets'),
});
const getFinalAnswerSection = (ctx: PromptContext) =>
  hbs.renderModule('finalAnswer', ctx).trim();

function makeContext(platform: PromptContext['platform']): PromptContext {
  return {
    sessionId: 'test',
    workingDirectory: 'E:\\Projects\\duya',
    platform,
    shell: 'bash',
    modelId: 'MiniMax-M3',
    enabledTools: new Set(),
    sessionStartTime: 0,
  } as PromptContext;
}

describe('finalAnswer section — file link rules', () => {
  it('Windows prompt forbids the /abs/ prefix in front of the drive letter', () => {
    const section = getFinalAnswerSection(makeContext('win32'));
    expect(section).toContain('NEVER add an `/abs/` or `/abs/path` prefix to a Windows path');
    // The Windows example must NOT teach the model the /abs/... form.
    expect(section).not.toMatch(/\]\(\/abs\/path\/[A-Za-z0-9_.-]+:\d+\)/);
  });

  it('macOS/Linux prompt shows /abs/path/ example without the Windows prohibition', () => {
    const section = getFinalAnswerSection(makeContext('darwin'));
    expect(section).toContain('[app.py](/abs/path/app.py:12)');
    expect(section).not.toContain('NEVER add an');
  });

  it('drops the bare-filename / relative-path fallback clause', () => {
    const win = getFinalAnswerSection(makeContext('win32'));
    const mac = getFinalAnswerSection(makeContext('darwin'));
    // Old: "If you do not know the absolute path, use a relative path or
    // bare filename: [network.py](network.py) or [network.py](network.py:12)."
    expect(win).not.toContain('relative path or bare filename');
    expect(mac).not.toContain('relative path or bare filename');
    expect(win).not.toContain('[network.py](network.py)');
    expect(mac).not.toContain('[network.py](network.py)');
  });

  it('coaches "say it in prose without a link" as the fallback when only the name is known', () => {
    const section = getFinalAnswerSection(makeContext('win32'));
    expect(section).toContain('say it in prose without a link');
  });

  it('forbids file://, vscode://, https:// URIs for local files', () => {
    const section = getFinalAnswerSection(makeContext('win32'));
    expect(section).toContain('Do not use URIs (file://, vscode://, https://) for local files');
  });
});

describe('BOT_BASIC_SYSTEM_PROMPT — file link rules', () => {
  // The bot prompt is byte-stable (no runtime branching), so we assert on
  // the static string. CI catches accidental rewrites that re-introduce
  // the cross-platform sentence pattern that previously produced hybrid
  // `/abs/E:/...` paths on Windows.
  it('does not mix Windows and /abs/path/ examples in one sentence about a single platform', () => {
    // Old: "(e.g. [app.py](C:/project/src/app.py:12) on Windows — never an
    // /abs/ prefix there; /abs/path/... on Unix)". The two examples must no
    // longer sit in the same sentence with a platform caveat mid-clause.
    expect(BOT_BASIC_SYSTEM_PROMPT).not.toContain('never an /abs/ prefix there');
    expect(BOT_BASIC_SYSTEM_PROMPT).not.toContain('; /abs/path/... on Unix');
  });

  it('shows both platform examples clearly and forbids /abs/ on Windows', () => {
    expect(BOT_BASIC_SYSTEM_PROMPT).toContain('[app.py](C:/project/src/app.py:12) on Windows');
    expect(BOT_BASIC_SYSTEM_PROMPT).toContain('[app.py](/abs/path/app.py:12) on macOS/Linux');
    expect(BOT_BASIC_SYSTEM_PROMPT).toContain(
      'On Windows never write an `/abs/` or `/abs/path` prefix',
    );
  });

  it('coaches "say it in prose without a link" as the fallback when only the name is known', () => {
    expect(BOT_BASIC_SYSTEM_PROMPT).toContain('say it in prose without a link');
  });

  it('does not coach the old relative-path-or-bare-filename fallback', () => {
    expect(BOT_BASIC_SYSTEM_PROMPT).not.toContain('relative path or bare filename');
  });
});