/**
 * Footer formatting: the two rows under the composer.
 *
 * The properties worth pinning are the ones a screen reader would notice: no
 * row ever exceeds the terminal width (a wrapped footer lands off-screen and
 * takes the composer with it), the model column is flush right, and the
 * counters survive truncation because dropping a number is worse than dropping
 * the last directory of a path.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildFooterLines,
  formatCwdForFooter,
  formatTokenCount,
  readGitBranch,
  type FooterInput,
} from '../footer.js';
import { DARK_THEME_TAGS } from '../theme.js';
import { stylesOf } from '../transcript-view.js';
import { visibleWidth } from '../width.js';

const styles = stylesOf({ theme: DARK_THEME_TAGS });

function footer(patch: Partial<FooterInput> = {}): string[] {
  return buildFooterLines({
    width: 80,
    cwd: 'E:\\Projects\\duya',
    branch: 'master',
    stats: {
      inputTokens: 49_000,
      outputTokens: 1600,
      totalTokens: 50_600,
      contextPercent: 5,
      contextBudget: 1_000_000,
    },
    model: { provider: 'deepseek', model: 'deepseek-flash', thinking: 'high' },
    styles,
    ...patch,
  });
}

/** Strip blessed tags so the assertions read the text, not the markup. */
function plain(line: string): string {
  return line.replace(/\{[^}]*\}/gu, '');
}

describe('formatTokenCount', () => {
  it('follows pi thresholds', () => {
    expect(formatTokenCount(940)).toBe('940');
    expect(formatTokenCount(1600)).toBe('1.6k');
    expect(formatTokenCount(49_000)).toBe('49k');
    expect(formatTokenCount(1_000_000)).toBe('1.0M');
    expect(formatTokenCount(2_500_000)).toBe('2.5M');
  });
});

describe('formatCwdForFooter', () => {
  it('shortens a path inside home to ~', () => {
    expect(formatCwdForFooter('/home/ann/work', '/home/ann')).toBe(join('~', 'work'));
    expect(formatCwdForFooter('/home/ann', '/home/ann')).toBe('~');
  });

  it('leaves a sibling that only shares a prefix alone', () => {
    expect(formatCwdForFooter('/home/anna', '/home/ann')).toBe('/home/anna');
  });

  it('leaves a path outside home alone', () => {
    expect(formatCwdForFooter('/srv/app', '/home/ann')).toBe('/srv/app');
  });
});

describe('readGitBranch', () => {
  it('reads the branch out of .git/HEAD', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-footer-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n');
      expect(readGitBranch(dir)).toBe('feature/x');
      // From a subdirectory, the repository above is still found.
      mkdirSync(join(dir, 'packages', 'cli'), { recursive: true });
      expect(readGitBranch(join(dir, 'packages', 'cli'))).toBe('feature/x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a detached HEAD as a short hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-footer-'));
    try {
      mkdirSync(join(dir, '.git'));
      writeFileSync(join(dir, '.git', 'HEAD'), '0123456789abcdef0123456789abcdef01234567\n');
      expect(readGitBranch(dir)).toBe('0123456');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves the gitdir pointer a worktree keeps in .git', () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-footer-'));
    try {
      const real = join(root, 'real');
      mkdirSync(real);
      writeFileSync(join(real, 'HEAD'), 'ref: refs/heads/worktree-branch\n');
      const worktree = join(root, 'worktree');
      mkdirSync(worktree);
      writeFileSync(join(worktree, '.git'), `gitdir: ${real}\n`);
      expect(readGitBranch(worktree)).toBe('worktree-branch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns null when there is no repository above the directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-footer-'));
    try {
      expect(readGitBranch(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildFooterLines', () => {
  it('renders exactly two rows', () => {
    expect(footer()).toHaveLength(2);
  });

  it('puts the path and branch on the first row', () => {
    expect(plain(footer()[0] ?? '')).toContain('E:\\Projects\\duya (master)');
  });

  it('puts the counters left and the model flush right', () => {
    const row = plain(footer()[1] ?? '');
    expect(row).toContain('↑49k');
    expect(row).toContain('↓1.6k');
    expect(row).toContain('Σ51k');
    expect(row).toContain('5%/1.0M');
    expect(row.endsWith('(deepseek) deepseek-flash • high')).toBe(true);
    expect(visibleWidth(row)).toBe(80);
  });

  it('keeps every row inside the width, however narrow', () => {
    for (const width of [20, 30, 40, 60, 80, 120]) {
      const rows = footer({ width, hint: 'Enter queue · Esc interrupt' });
      for (const row of rows) {
        expect(visibleWidth(plain(row))).toBeLessThanOrEqual(width);
      }
    }
  });

  it('drops the model before it drops the counters', () => {
    const narrow = plain(footer({ width: 34 })[1] ?? '');
    expect(narrow).toContain('↑49k');
    expect(narrow).toContain('Σ51k');
  });

  it('omits the branch when there is none', () => {
    expect(plain(footer({ branch: null })[0] ?? '')).not.toContain('(');
  });

  it('appends the session name after the path', () => {
    expect(plain(footer({ sessionName: 'refactor' })[0] ?? '')).toContain('• refactor');
  });

  it('right-aligns the hint on the first row', () => {
    const row = plain(footer({ hint: '/ commands · F1 help' })[0] ?? '');
    expect(row.endsWith('/ commands · F1 help')).toBe(true);
    expect(visibleWidth(row)).toBe(80);
  });

  it('shows `?` for the percentage before the first billed call', () => {
    const row = plain(footer({
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextPercent: null,
        contextBudget: 1_000_000,
      },
    })[1] ?? '');
    expect(row).toContain('?/1.0M');
  });

  it('keeps a blank second row when there is nothing to report', () => {
    const rows = footer({
      stats: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextPercent: null,
        contextBudget: null,
      },
      model: null,
    });
    expect(rows).toHaveLength(2);
    expect(plain(rows[1] ?? '')).toBe('');
  });

  it('colours the context percentage only when it is a warning', () => {
    const hot = footer({
      stats: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 950_000,
        contextPercent: 95,
        contextBudget: 1_000_000,
      },
    })[1] ?? '';
    expect(hot).toContain('{bright-red-fg}95%/1.0M{/bright-red-fg}');
    const warm = footer({
      stats: {
        inputTokens: 1,
        outputTokens: 1,
        totalTokens: 800_000,
        contextPercent: 80,
        contextBudget: 1_000_000,
      },
    })[1] ?? '';
    expect(warm).toContain('{yellow-fg}80%/1.0M{/yellow-fg}');
    // Below the warning threshold it is plain muted, not coloured.
    expect(footer()[1]).not.toContain('bright-red-fg');
  });
});
