/**
 * transcript-md + transcript-commands tests (plan 554).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTranscriptMarkdown, getLastReplyText } from '../transcript-md.js';
import { handleTranscriptCommand, isTranscriptControlCommand } from '../transcript-commands.js';
import type { Message } from '../../types.js';

function msg(role: Message['role'], content: Message['content']): Message {
  return { role, content, timestamp: Date.now() };
}

const SAMPLE: Message[] = [
  msg('user', 'Fix the login bug'),
  msg('assistant', [
    { type: 'text', text: 'I found the off-by-one and fixed it.' },
    { type: 'tool_use', name: 'edit', input: { file_path: 'src/auth.ts' } },
    { type: 'tool_result', content: 'Applied the patch.' },
    { type: 'thinking', thinking: 'checked the boundary condition first' },
  ]),
  msg('user', 'thanks'),
  msg('assistant', 'All verified — tests are green.\nVERDICT: PASS'),
];

describe('buildTranscriptMarkdown', () => {
  it('renders roles, collapses tool traffic, keeps prose', () => {
    const md = buildTranscriptMarkdown(SAMPLE, { sessionId: 'sess-1234' });
    expect(md).toContain('# Duya Transcript');
    expect(md).toContain('Session: sess-1234');
    expect(md).toContain('Messages: 4');
    expect(md).toContain('### 🧑 User');
    expect(md).toContain('### 🤖 Assistant');
    expect(md).toContain('I found the off-by-one and fixed it.');
    expect(md).toContain('`edit`');
    expect(md).toContain('Applied the patch.');
    expect(md).toContain('<details><summary>thinking</summary>');
  });

  it('empty transcripts still render a valid header', () => {
    const md = buildTranscriptMarkdown([], { header: false });
    expect(md).toBe('# Duya Transcript\n');
  });
});

describe('getLastReplyText', () => {
  it('returns the last assistant prose, skipping tool blocks', () => {
    expect(getLastReplyText(SAMPLE)).toBe('All verified — tests are green.\nVERDICT: PASS');
  });

  it('returns undefined with no assistant text', () => {
    expect(getLastReplyText([msg('user', 'hi')])).toBeUndefined();
  });
});

describe('handleTranscriptCommand', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'duya-transcript-'));
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it('dispatches only the three control verbs', () => {
    expect(isTranscriptControlCommand('/export out.md')).toBe(true);
    expect(isTranscriptControlCommand('/copy')).toBe(true);
    expect(isTranscriptControlCommand('/transcript')).toBe(true);
    expect(isTranscriptControlCommand('/exports')).toBe(false);
    expect(isTranscriptControlCommand('fix the bug')).toBe(false);
  });

  it('/export writes the markdown file and reports the path', () => {
    const result = handleTranscriptCommand('/export out/transcript.md', {
      messages: SAMPLE,
      sessionId: 'sess-1234',
      workingDirectory: workdir,
    });
    expect(result.handled).toBe(true);
    const target = join(workdir, 'out', 'transcript.md');
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, 'utf-8')).toContain('Fix the login bug');
    expect(result.reply).toContain('Transcript exported');
    expect(result.reply).toContain('4 messages');
  });

  it('/export with no path writes a timestamped default', () => {
    const result = handleTranscriptCommand('/export', {
      messages: SAMPLE,
      workingDirectory: workdir,
    });
    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/transcript-\d{8}-\d{6}\.md/);
  });

  it('/export on an empty transcript says so without writing', () => {
    const result = handleTranscriptCommand('/export', { messages: [], workingDirectory: workdir });
    expect(result.reply).toContain('Nothing to export');
  });

  it('/copy returns the clipboard payload for the renderer', () => {
    const result = handleTranscriptCommand('/copy', { messages: SAMPLE });
    expect(result.clipboardText).toBe('All verified — tests are green.\nVERDICT: PASS');
    expect(result.reply).toContain('copied');
  });

  it('/copy with no replies reports it', () => {
    const result = handleTranscriptCommand('/copy', { messages: [msg('user', 'hi')] });
    expect(result.clipboardText).toBeUndefined();
    expect(result.reply).toContain('No assistant reply');
  });

  it('/transcript reports counts and hints at /export', () => {
    const result = handleTranscriptCommand('/transcript', { messages: SAMPLE });
    expect(result.reply).toContain('4 message(s)');
    expect(result.reply).toContain('/export');
  });
});
