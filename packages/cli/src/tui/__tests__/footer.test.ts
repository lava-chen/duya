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
import { encodeHyperlinkTag } from '../core/span.js';
import { permissionBadge } from '../permission-mode.js';
import type { PrBadge } from '../pr-badge.js';
import { stylesOf } from '../transcript-view.js';
import { lineToAnsi } from '../terminal/line.js';
import { visibleWidth } from '../width.js';

const styles = stylesOf({ theme: DARK_THEME_TAGS });

/** The badge the Host observed for the session under test. */
const PR_BADGE: PrBadge = {
  repo: 'lava-chen/duya',
  prNumber: 123,
  state: 'open',
  url: 'https://github.com/lava-chen/duya/pull/123',
  observedAt: 1_700_000_000_000,
  label: 'PR #123',
};

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
      outputTokensPerSecond: null,
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
  it('supports compact, location-only and usage-only layouts', () => {
    const compact = footer({ statusline: 'compact' }).map(plain).join(' ');
    expect(compact).toContain('E:\\Projects\\duya');
    expect(compact).toContain('↑49k');
    expect(compact).toContain('deepseek-flash');
    expect(compact).not.toContain('(master)');
    const location = footer({ statusline: 'location' }).map(plain).join(' ');
    expect(location).toContain('(master)');
    expect(location).not.toContain('↑49k');
    const usage = footer({ statusline: 'usage' }).map(plain).join(' ');
    expect(usage).toContain('↑49k');
    expect(usage).not.toContain('E:\\Projects\\duya');
  });

  it('shows the pull request badge between the path and the session name', () => {
    const row = plain(footer({
      sessionName: 'pr-badge',
      pullRequest: PR_BADGE,
    })[0] ?? '');
    expect(row).toContain('E:\\Projects\\duya (master) • PR #123 • pr-badge');
  });

  it('paints the badge by the state the Host observed', () => {
    const failing = footer({ pullRequest: { ...PR_BADGE, state: 'checks_failing' } })[0] ?? '';
    expect(failing).toContain('{bright-red-fg}PR #123{/bright-red-fg}');
    const merged = footer({ pullRequest: { ...PR_BADGE, state: 'merged' } })[0] ?? '';
    expect(merged).toContain('{bright-green-fg}PR #123{/bright-green-fg}');
  });

  it('links the badge only when the terminal can carry a hyperlink', () => {
    const linked = footer({ pullRequest: PR_BADGE, hyperlinks: true })[0] ?? '';
    expect(linked).toContain(`{${encodeHyperlinkTag(PR_BADGE.url ?? '')}}`);
    const unlinked = footer({ pullRequest: PR_BADGE, hyperlinks: false })[0] ?? '';
    expect(unlinked).not.toContain('link-');
  });

  it('keeps the badge out of the narrow profiles', () => {
    const compact = plain(footer({ statusline: 'compact', pullRequest: PR_BADGE })[0] ?? '');
    expect(compact).not.toContain('PR #123');
    const location = plain(footer({ statusline: 'location', pullRequest: PR_BADGE })[0] ?? '');
    expect(location).toContain('PR #123');
  });

  it('carries the badge link through to the terminal bytes', () => {
    const row = footer({ pullRequest: PR_BADGE, hyperlinks: true })[0] ?? '';
    const ansi = lineToAnsi(row);
    const open = ansi.indexOf('\u001b]8;;https://github.com/lava-chen/duya/pull/123\u001b\\');
    const close = ansi.indexOf('\u001b]8;;\u001b\\', open + 1);
    expect(open).toBeGreaterThan(0);
    // The link covers the badge only: it is closed before the rest of the row.
    expect(close).toBeGreaterThan(open);
  });

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

  it('shows the measured output rate when the provider reported a duration', () => {
    const row = plain(footer({
      stats: {
        inputTokens: 49_000,
        outputTokens: 1600,
        totalTokens: 50_600,
        contextPercent: 5,
        contextBudget: 1_000_000,
        outputTokensPerSecond: 63,
      },
    })[1] ?? '');
    expect(row).toContain('63.0 tok/s');
  });

  it('keeps the three kinds of number as three groups', () => {
    // Spend, window and speed are three different answers. Printed with a bare
    // space between every token they read as one undifferentiated run, which is
    // what made this row look untidy rather than informative.
    const row = plain(footer({
      stats: {
        inputTokens: 49_000,
        outputTokens: 1600,
        totalTokens: 50_600,
        contextPercent: 5,
        contextBudget: 1_000_000,
        outputTokensPerSecond: 63,
      },
    })[1] ?? '');
    expect(row).toContain('↑49k ↓1.6k Σ51k · 5%/1.0M · 63.0 tok/s');
  });

  it('colours the rate as the one live measurement on the row', () => {
    const row = footer({
      stats: {
        inputTokens: 49_000,
        outputTokens: 1600,
        totalTokens: 50_600,
        contextPercent: 5,
        contextBudget: 1_000_000,
        outputTokensPerSecond: 63,
      },
    })[1] ?? '';
    expect(row).toContain('{cyan-fg}63.0 tok/s{/cyan-fg}');
    // The counters stay muted: colour means kind here, not emphasis.
    expect(row).toContain('{gray-fg}↑49k ↓1.6k Σ51k{/gray-fg}');
  });

  it('omits the rate entirely when the provider reported no duration', () => {
    // A missing duration is not a zero rate: it says "nobody measured this
    // call", and showing `0.0 tok/s` as a rate would be a measurement nobody made.
    const row = plain(footer()[1] ?? '');
    expect(row).not.toContain('tok/s');
  });

  it('keeps the rate inside the width, however narrow', () => {
    for (const width of [20, 30, 40, 60, 80, 120]) {
      const rows = footer({
        width,
        stats: {
          inputTokens: 49_000,
          outputTokens: 1600,
          totalTokens: 50_600,
          contextPercent: 5,
          contextBudget: 1_000_000,
          outputTokensPerSecond: 63,
        },
      });
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
        outputTokensPerSecond: null,
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
        outputTokensPerSecond: null,
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
        outputTokensPerSecond: null,
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
        outputTokensPerSecond: null,
      },
    })[1] ?? '';
    expect(warm).toContain('{yellow-fg}80%/1.0M{/yellow-fg}');
    // Below the warning threshold it is plain muted, not coloured.
    expect(footer()[1]).not.toContain('bright-red-fg');
  });
});

describe('the permission badge', () => {
  it('sits at the right of the stats row, before the model', () => {
    const row = plain(footer({ permission: permissionBadge('ask', false) })[1] ?? '');
    expect(row).toContain('[ask]');
    expect(row).toContain('Shift+Tab');
    // The badge is to the LEFT of the model: the model is what the row is
    // flush against, and the badge is what it says about the session.
    expect(row.indexOf('[ask]')).toBeLessThan(row.indexOf('deepseek-flash'));
  });

  it('colours the mode that grants everything as an error', () => {
    expect(footer({ permission: permissionBadge('bypass', false) })[1] ?? '')
      .toContain('{bright-red-fg}[bypass]{/bright-red-fg}');
  });

  it('keeps the badge when the row is too narrow for the hint', () => {
    const row = plain(footer({
      width: 40,
      permission: permissionBadge('ask', false),
    })[1] ?? '');
    expect(row).toContain('[ask]');
    expect(row).not.toContain('Shift+Tab');
  });

  it('never lets a row exceed the terminal width', () => {
    for (const width of [20, 30, 40, 60, 80, 120]) {
      for (const mode of ['ask', 'auto', 'bypass'] as const) {
        const rows = footer({ width, permission: permissionBadge(mode, false) });
        for (const row of rows) {
          expect(visibleWidth(plain(row))).toBeLessThanOrEqual(width);
        }
      }
    }
  });
});
