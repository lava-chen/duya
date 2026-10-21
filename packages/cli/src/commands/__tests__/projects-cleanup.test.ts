/**
 * packages/cli/src/commands/__tests__/projects-cleanup.test.ts
 *
 * Plan 536 §2.5 — unit tests for the project cleanup scanner.
 *
 * Verifies the heuristic for classifying project directories
 * (empty UUID vs. non-empty UUID vs. legacy non-UUID names),
 * the dry-run output, and the --apply / --yes / --archive-dir
 * safety rails.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  scanProjects,
  runProjectsCleanupCommand,
  type ProjectDirReport,
} from '../projects-cleanup.js';

let worktreeRoot: string;

function makeProjectDir(name: string, populate?: (dir: string) => void): string {
  const dir = path.join(worktreeRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  if (populate) populate(dir);
  return dir;
}

function writePlanFile(dir: string, fileName = '1-test.md', body = '# test plan\n\n## Checkbox\n- [ ] first\n'): void {
  const plansDir = path.join(dir, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, fileName), body, 'utf8');
}

function writeTemplateAgentsMd(dir: string): void {
  // Default template content (auto-seeded by duya)
  const body = '# Project\n\n## 1. What this project is\n\n_Describe the project: goal, scope, audience, success criteria._\n';
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), body, 'utf8');
}

function writeUserEditedAgentsMd(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'AGENTS.md'),
    '# My project\n\nI edited this myself.\n',
    'utf8',
  );
}

beforeEach(() => {
  worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-projects-test-'));
  process.env.DUYA_PROJECTS_ROOT = worktreeRoot;
});

afterEach(() => {
  fs.rmSync(worktreeRoot, { recursive: true, force: true });
});

describe('scanProjects — classification', () => {
  it('returns an empty report when projects dir does not exist', () => {
    const report = scanProjects({ projectsRoot: path.join(worktreeRoot, 'nonexistent') });
    expect(report.scanned).toBe(0);
    expect(report.emptyUuids).toEqual([]);
    expect(report.nonUuidNames).toEqual([]);
    expect(report.keptNonEmptyUuids).toEqual([]);
  });

  it('flags an empty UUID-named directory for deletion', () => {
    makeProjectDir('e4e2b217-4916-47fa-af5b-a3096c7f5c0d'); // bare dir, nothing inside
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.scanned).toBe(1);
    expect(report.emptyUuids).toEqual(['e4e2b217-4916-47fa-af5b-a3096c7f5c0d']);
    expect(report.entries[0].suggestedAction).toBe('delete');
    expect(report.entries[0].isUuid).toBe(true);
    expect(report.entries[0].isEmpty).toBe(true);
  });

  it('keeps a UUID directory with a plan file', () => {
    makeProjectDir('a1b2c3d4-1111-2222-3333-444455556666', (dir) => writePlanFile(dir));
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.emptyUuids).toEqual([]);
    expect(report.keptNonEmptyUuids).toEqual(['a1b2c3d4-1111-2222-3333-444455556666']);
    expect(report.entries[0].suggestedAction).toBe('keep');
  });

  it('keeps a UUID directory with user-edited AGENTS.md', () => {
    makeProjectDir('b2c3d4e5-2222-3333-4444-555566667777', (dir) => writeUserEditedAgentsMd(dir));
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.emptyUuids).toEqual([]);
    expect(report.keptNonEmptyUuids).toEqual(['b2c3d4e5-2222-3333-4444-555566667777']);
    expect(report.entries[0].suggestedAction).toBe('keep');
  });

  it('flags a UUID directory as empty even if AGENTS.md is the template default', () => {
    makeProjectDir('c3d4e5f6-3333-4444-5555-666677778888', (dir) => writeTemplateAgentsMd(dir));
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.emptyUuids).toEqual(['c3d4e5f6-3333-4444-5555-666677778888']);
    expect(report.entries[0].suggestedAction).toBe('delete');
  });

  it('treats a legacy non-UUID name (`duya`) as archive, not delete', () => {
    const duyaDir = makeProjectDir('duya');
    fs.mkdirSync(path.join(duyaDir, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(duyaDir, 'plans/index.json'), '{"projectId":"duya","plans":[]}', 'utf8');
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.nonUuidNames).toEqual(['duya']);
    expect(report.entries[0].isUuid).toBe(false);
    expect(report.entries[0].suggestedAction).toBe('archive');
    expect(report.entries[0].note).toContain('Non-UUID');
    expect(report.emptyUuids).not.toContain('duya');
  });

  it('does not treat `duya` as empty even when it really is empty', () => {
    makeProjectDir('duya'); // bare, no contents
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.nonUuidNames).toEqual(['duya']);
    expect(report.entries[0].suggestedAction).toBe('archive'); // archive, not delete
  });

  it('keeps UUID directories that have non-AGENTS/non-plans contents', () => {
    makeProjectDir('d4e5f6a7-4444-5555-6666-777788889999', (dir) => {
      fs.mkdirSync(path.join(dir, 'extra'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'extra', 'note.txt'), 'hi', 'utf8');
    });
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.keptNonEmptyUuids).toEqual(['d4e5f6a7-4444-5555-6666-777788889999']);
  });

  it('handles mixed corpus correctly', () => {
    makeProjectDir('a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd'); // empty UUID
    makeProjectDir('b2b2b2b2-aaaa-bbbb-cccc-dddddddddddd', (dir) => writePlanFile(dir));
    makeProjectDir('c3c3c3c3-aaaa-bbbb-cccc-dddddddddddd', (dir) => writeUserEditedAgentsMd(dir));
    makeProjectDir('duya');
    const report = scanProjects({ projectsRoot: worktreeRoot });
    expect(report.scanned).toBe(4);
    expect(report.emptyUuids).toEqual(['a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd']);
    expect(report.nonUuidNames).toEqual(['duya']);
    expect(report.keptNonEmptyUuids.sort()).toEqual([
      'b2b2b2b2-aaaa-bbbb-cccc-dddddddddddd',
      'c3c3c3c3-aaaa-bbbb-cccc-dddddddddddd',
    ]);
  });

  it('records per-entry contents for traceability', () => {
    const dir = makeProjectDir('e5f6a7b8-5555-6666-7777-888899990000', (d) => writePlanFile(d, '99-test.md'));
    const report = scanProjects({ projectsRoot: worktreeRoot });
    const entry = report.entries[0] as ProjectDirReport;
    expect(entry.contents).toContain('plans');
  });
});

describe('runProjectsCleanupCommand — safety rails', () => {
  function setupDefault(): void {
    makeProjectDir('a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd'); // empty
    makeProjectDir('b2b2b2b2-aaaa-bbbb-cccc-dddddddddddd'); // empty
    makeProjectDir('duya');
  }

  it('dry-run by default — prints report, makes no changes', async () => {
    setupDefault();
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s: string) => { out.push(s); return true; };
    process.stderr.write = (s: string) => { err.push(s); return true; };

    try {
      const code = await runProjectsCleanupCommand({
        args: [],
        options: {},
        format: 'text',
      });
      expect(code).toBe(0);
      const text = out.join('');
      expect(text).toContain('dry-run');
      expect(text).toContain('empty (UUID, safe to delete): 2');
      expect(text).toContain('non-UUID (legacy names):      1');
      // File system untouched
      expect(fs.existsSync(path.join(worktreeRoot, 'a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd'))).toBe(true);
      expect(fs.existsSync(path.join(worktreeRoot, 'duya'))).toBe(true);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
  });

  it('--apply without --yes in non-TTY returns exit 3', async () => {
    setupDefault();
    // Force non-TTY
    const orig = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    const err: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (s: string) => { err.push(s); return true; };

    try {
      const code = await runProjectsCleanupCommand({
        args: [],
        options: { apply: true },
        format: 'text',
      });
      expect(code).toBe(3);
      expect(err.join('')).toContain('Refusing to apply');
      // Nothing deleted
      expect(fs.existsSync(path.join(worktreeRoot, 'a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd'))).toBe(true);
    } finally {
      process.stderr.write = origErr;
      Object.defineProperty(process.stdin, 'isTTY', { value: orig, configurable: true });
    }
  });

  it('--apply --yes deletes empty UUIDs but never `duya`', async () => {
    setupDefault();
    const out: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string) => { out.push(s); return true; };

    try {
      const code = await runProjectsCleanupCommand({
        args: [],
        options: { apply: true, yes: true },
        format: 'text',
      });
      expect(code).toBe(0);
      // Empty UUIDs gone
      expect(fs.existsSync(path.join(worktreeRoot, 'a1a1a1a1-aaaa-bbbb-cccc-dddddddddddd'))).toBe(false);
      expect(fs.existsSync(path.join(worktreeRoot, 'b2b2b2b2-aaaa-bbbb-cccc-dddddddddddd'))).toBe(false);
      // duya untouched
      expect(fs.existsSync(path.join(worktreeRoot, 'duya'))).toBe(true);
      const text = out.join('');
      expect(text).toContain('deleted: 2');
      expect(text).toContain('archived: 0'); // no --archive-dir, so duya skipped silently
    } finally {
      process.stdout.write = origOut;
    }
  });

  it('--apply --yes with --archive-dir copies `duya` to archive target', async () => {
    setupDefault();
    const archiveDir = path.join(worktreeRoot, 'archive');
    const out: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string) => { out.push(s); return true; };

    try {
      const code = await runProjectsCleanupCommand({
        args: [],
        options: { apply: true, yes: true, archiveDir },
        format: 'text',
      });
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(worktreeRoot, 'duya'))).toBe(true); // original untouched
      // An archive dir for `duya` was created
      const archived = fs.readdirSync(archiveDir);
      expect(archived.length).toBe(1);
      expect(archived[0]?.startsWith('duya-')).toBe(true);
    } finally {
      process.stdout.write = origOut;
    }
  });

  it('json format emits structured report', async () => {
    setupDefault();
    const out: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s: string) => { out.push(s); return true; };

    try {
      const code = await runProjectsCleanupCommand({
        args: [],
        options: {},
        format: 'json',
      });
      expect(code).toBe(0);
      const text = out.join('');
      const parsed = JSON.parse(text);
      expect(parsed.scanned).toBe(3);
      expect(parsed.emptyUuids.length).toBe(2);
      expect(parsed.nonUuidNames).toEqual(['duya']);
      expect(parsed.applied).toBeUndefined(); // dry-run, no applied section
    } finally {
      process.stdout.write = origOut;
    }
  });
});