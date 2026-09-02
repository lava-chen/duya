import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// os.homedir() is a non-configurable ESM namespace export, so vi.spyOn fails.
// Mock the module instead, preserving all other os functions.
vi.mock('os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('os')>();
  return { ...mod, homedir: vi.fn() };
});

import { getMemorySection } from '../memorySection';
import type { PromptContext } from '../../../types';

interface SectionEnv {
  duyaRoot: string;
  memoryRoot: string;
  configRoot: string;
  cleanup: () => void;
}

function makeEnv(): SectionEnv {
  const duyaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-section-'));
  const memoryRoot = path.join(duyaRoot, 'memory');
  const configRoot = path.join(duyaRoot, 'memory-config');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  return {
    duyaRoot,
    memoryRoot,
    configRoot,
    cleanup: () => { try { fs.rmSync(duyaRoot, { recursive: true, force: true }); } catch { /* best-effort */ } },
  };
}

function makeCtx(workingDir: string): PromptContext {
  return { workingDirectory: workingDir } as PromptContext;
}

describe('getMemorySection', () => {
  let env: SectionEnv;

  beforeEach(() => {
    env = makeEnv();
    // memorySection.ts calls os.homedir() then joins '.duya/memory'. On
    // Windows os.homedir() reads USERPROFILE (not HOME), so env-var override
    // is unreliable — mock os.homedir() to return our temp dir's parent so
    // path.join(homedir(), '.duya') === env.duyaRoot.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-home-'));
    fs.symlinkSync(env.duyaRoot, path.join(fakeHome, '.duya'));
    vi.mocked(os.homedir).mockReturnValue(fakeHome);
    env.cleanup = () => {
      try {
        fs.rmSync(fakeHome, { recursive: true, force: true });
        fs.rmSync(env.duyaRoot, { recursive: true, force: true });
      } catch { /* best-effort */ }
    };
  });

  afterEach(() => {
    vi.mocked(os.homedir).mockReset();
    env.cleanup();
  });

  it('renders memory layout with summary, MEMORY.md, and rollout_summaries paths', () => {
    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('## Memory');
    expect(section).toContain('summary.md');
    expect(section).toContain('MEMORY.md');
    expect(section).toContain('rollout_summaries');
    expect(section).toContain('MEMORY_SUMMARY BEGINS');
    expect(section).toContain('MEMORY_SUMMARY ENDS');
  });

  it('inlines summary.md content when present', () => {
    const summaryPath = path.join(env.memoryRoot, 'summary.md');
    fs.writeFileSync(summaryPath, '# Test Summary\n\nThis is a test memory summary.', 'utf8');

    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('This is a test memory summary.');
    expect(section).toContain('MEMORY_SUMMARY BEGINS');
    expect(section).toContain('MEMORY_SUMMARY ENDS');
  });

  it('shows placeholder when summary.md is absent', () => {
    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('_(summary.md not yet generated)_');
  });

  it('mentions duya memory search command', () => {
    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('duya memory search');
  });

  it('contains decision boundary and quick memory pass', () => {
    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('Decision boundary');
    expect(section).toContain('Quick memory pass');
    expect(section).toContain('Quick-pass budget');
  });

  it('contains updating memories instructions', () => {
    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('Updating memories');
    expect(section).toContain('ad_hoc');
    expect(section).toContain('timestamp');
  });

  it('does not contain RAG references (simplified, Codex-style)', () => {
    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).not.toContain('RAG');
    expect(section).not.toContain('UserPromptSubmit');
    expect(section).not.toContain('duya-mem-citation');
  });

  it('truncates summary.md at 12000 chars', () => {
    const summaryPath = path.join(env.memoryRoot, 'summary.md');
    fs.writeFileSync(summaryPath, 'x'.repeat(15000), 'utf8');

    const section = getMemorySection(makeCtx('/tmp'));

    expect(section).toContain('... [truncated]');
    expect(section).not.toContain('x'.repeat(15000));
  });
});
