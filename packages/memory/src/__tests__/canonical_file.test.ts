import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseCanonicalFile, type ParsedCanonicalFile } from '../canonical_file';

/**
 * Parse tests extracted from the retired `memory_entries_rebuild.test.ts`
 * (Plan 479 §6.4 cleanup): the parser moved to `canonical_file.ts`, while
 * the `rebuildMemoryEntriesFromFiles` cache tests died with the
 * `memory_entries` table (dropped by migration 0009).
 */

interface ParseEnv {
  root: string;
  cleanup: () => void;
}

function makeEnv(): ParseEnv {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-parse-'));
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    },
  };
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

describe('parseCanonicalFile', () => {
  let env: ParseEnv;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it('parses a valid canonical file with full frontmatter', () => {
    const file = path.join(env.root, 'items', 'preference', 'verification-style.md');
    write(
      file,
      [
        '---',
        'memory_id: mem_abc123',
        'canonical_key: preference:verification-style',
        'claim_type: preference',
        'scope: project',
        'scope_id: duya',
        'project_id: 11111111-1111-1111-1111-111111111111',
        'status: active',
        'importance: essential',
        'summary_eligible: true',
        'updated_at: 2026-08-03T12:00:00Z',
        '---',
        '',
        '# Verification style',
        '',
        'Prefer Playwright MCP for UI verification.',
      ].join('\n')
    );

    const result = parseCanonicalFile(file);
    const expected: ParsedCanonicalFile = {
      memory_id: 'mem_abc123',
      canonical_key: 'preference:verification-style',
      claim_type: 'preference',
      scope: 'project',
      scope_id: 'duya',
      project_id: '11111111-1111-1111-1111-111111111111',
      status: 'active',
      importance: 'essential',
      file_path: file,
      updated_at: '2026-08-03T12:00:00Z',
    };
    expect(result).toEqual(expected);
  });

  it('returns null when the file has no frontmatter', () => {
    const file = path.join(env.root, 'items', 'preference', 'no-fm.md');
    write(file, '# No frontmatter\n\nJust body text.');
    expect(parseCanonicalFile(file)).toBeNull();
  });

  it('returns null when required fields are missing (no canonical_key)', () => {
    const file = path.join(env.root, 'items', 'preference', 'incomplete.md');
    write(
      file,
      [
        '---',
        'memory_id: mem_x',
        'claim_type: preference',
        'status: active',
        '---',
        '',
        'Body',
      ].join('\n')
    );
    expect(parseCanonicalFile(file)).toBeNull();
  });

  it('returns null when the file does not exist', () => {
    expect(parseCanonicalFile(path.join(env.root, 'missing.md'))).toBeNull();
  });

  it('parses a retired file (status=retired) for downstream status filtering', () => {
    const file = path.join(env.root, 'items', 'fact', 'old-truth.md');
    write(
      file,
      [
        '---',
        'memory_id: mem_retired',
        'canonical_key: fact:old-truth',
        'claim_type: fact',
        'scope: global',
        'scope_id: null',
        'project_id: null',
        'status: retired',
        'importance: normal',
        'summary_eligible: false',
        'updated_at: 2026-01-01T00:00:00Z',
        '---',
        '',
        'Stale.',
      ].join('\n')
    );
    const result = parseCanonicalFile(file);
    expect(result?.status).toBe('retired');
    expect(result?.canonical_key).toBe('fact:old-truth');
  });
});
