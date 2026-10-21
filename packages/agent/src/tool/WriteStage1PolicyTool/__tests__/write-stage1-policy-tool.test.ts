import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteStage1PolicyTool } from '../WriteStage1PolicyTool.js';

describe('WriteStage1PolicyTool', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('writes the policy file and increments the version sidecar', async () => {
    const tool = new WriteStage1PolicyTool();
    const res = await tool.execute({ content: '# Policy\nFocus on preferences.' }, root);
    expect(res.error).toBeFalsy();
    const policyPath = path.join(root, 'memory-config', 'stage1_policy.md');
    expect(fs.existsSync(policyPath)).toBe(true);
    expect(fs.readFileSync(policyPath, 'utf8')).toContain('Focus on preferences');
    expect(fs.readFileSync(`${policyPath}.version`, 'utf8').trim()).toBe('1');
  });

  it('increments from an existing version sidecar', async () => {
    const policyPath = path.join(root, 'memory-config', 'stage1_policy.md');
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, 'old', 'utf8');
    fs.writeFileSync(`${policyPath}.version`, '3', 'utf8');
    const tool = new WriteStage1PolicyTool();
    await tool.execute({ content: 'new' }, root);
    expect(fs.readFileSync(`${policyPath}.version`, 'utf8').trim()).toBe('4');
  });
});
