import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GrepTool } from '../GrepTool.js';

describe('debug', () => {
  it('prints grep result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'duya-dbg-'));
    mkdirSync(join(root, 'memory'), { recursive: true });
    writeFileSync(join(root, 'memory', 'a.md'), 'needle in haystack\nsecond line\n');
    const tool = new GrepTool({ workingDirectory: join(root, 'memory') });
    const r = await tool.execute({ pattern: 'needle' });
    console.log('DEBUG RESULT:', JSON.stringify(r.result));
    console.log('DEBUG ERROR:', r.error);
    console.log('DEBUG METADATA:', JSON.stringify(r.metadata));
    rmSync(root, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});