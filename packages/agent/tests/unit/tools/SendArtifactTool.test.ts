import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SendArtifactTool } from '../../../src/tool/SendArtifactTool/SendArtifactTool.js';

describe('SendArtifactTool', () => {
  const tool = new SendArtifactTool();

  it('requires file_paths', async () => {
    const res = await tool.execute({});
    expect(res.error).toBe(true);
    expect(res.result).toContain('no file_paths');
  });

  it('reports missing files as an error', async () => {
    const res = await tool.execute({ file_paths: ['/definitely/not/a/real/file.txt'] });
    expect(res.error).toBe(true);
    expect(res.result).toContain('not found');
  });

  it('returns a MEDIA directive per existing file', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-artifact-'));
    const a = path.join(dir, 'report.pdf');
    const b = path.join(dir, 'image.png');
    fs.writeFileSync(a, 'x');
    fs.writeFileSync(b, 'y');

    const res = await tool.execute({ file_paths: [a, b] });
    expect(res.error).toBeFalsy();
    expect(res.result).toContain(`MEDIA:${a}`);
    expect(res.result).toContain(`MEDIA:${b}`);
  });
});