/**
 * GrepTool sensitive-file exclusion tests (plan 554): credential material
 * never enters the context unless `include_sensitive` is set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool, isSensitiveFilename } from '../GrepTool.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duya-grep-sensitive-'));
  mkdirSync(join(root, 'app'), { recursive: true });
  writeFileSync(join(root, 'app', 'code.txt'), 'needle in plain sight\n');
  // Hidden credential dotfile.
  writeFileSync(join(root, '.env'), 'SECRET_TOKEN=hunter2\nneedle in the env file\n');
  // Non-hidden ssh-key-style file.
  writeFileSync(join(root, 'id_rsa_backup'), 'needle in the key file\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function matches(resultText: string): number {
  const parsed = JSON.parse(resultText) as { matches?: Array<{ content: string }> };
  return (parsed.matches ?? []).filter((m) => m.content.includes('needle')).length;
}

describe('GrepTool sensitive-file exclusion (plan 554)', () => {
  it('excludes .env and ssh-key files by default', async () => {
    const tool = new GrepTool({ workingDirectory: root });
    const result = await tool.execute({ pattern: 'needle' });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result) as Record<string, unknown>;
    expect(parsed.sensitiveExcluded).toBe(true);
    // Only the plain code file survives the filter.
    expect(matches(result.result)).toBe(1);
  });

  it('include_sensitive=true opts back in', async () => {
    const tool = new GrepTool({ workingDirectory: root });
    const result = await tool.execute({ pattern: 'needle', include_sensitive: true });
    expect(result.error).toBeFalsy();
    const parsed = JSON.parse(result.result) as Record<string, unknown>;
    expect(parsed.sensitiveExcluded).toBeUndefined();
    // .env + id_rsa_backup + code.txt all searched.
    expect(matches(result.result)).toBe(3);
  });

  it('isSensitiveFilename matches the catalog on basenames', () => {
    expect(isSensitiveFilename('.env')).toBe(true);
    expect(isSensitiveFilename('.env.local')).toBe(true);
    expect(isSensitiveFilename('server.pem')).toBe(true);
    expect(isSensitiveFilename('PRIVATE.key')).toBe(true);
    expect(isSensitiveFilename('id_ed25519.pub')).toBe(true);
    expect(isSensitiveFilename('app.ts')).toBe(false);
    expect(isSensitiveFilename('environment.ts')).toBe(false);
  });

  it('validateGrepInput accepts the include_sensitive flag', async () => {
    const tool = new GrepTool({ workingDirectory: root });
    const bad = await tool.execute({ pattern: 'needle', include_sensitive: 'yes' });
    expect(bad.error).toBe(true);
    expect(bad.result).toContain('include_sensitive must be a boolean');
  });
});
