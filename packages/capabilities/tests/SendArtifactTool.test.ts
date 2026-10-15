import { describe, expect, it, vi } from 'vitest';
import { SendArtifactTool } from '../src/SendArtifactTool/SendArtifactTool.js';

describe('SendArtifactTool capability', () => {
  it('requires at least one non-empty file path', async () => {
    const tool = new SendArtifactTool({ exists: vi.fn(() => true) });

    const result = await tool.execute({ file_paths: ['  '] });

    expect(result.error).toBe(true);
    expect(result.result).toBe('send_artifact: no file_paths provided.');
  });

  it('reports paths the injected filesystem cannot find', async () => {
    const exists = vi.fn((path: string) => path !== '/missing/report.pdf');
    const tool = new SendArtifactTool({ exists });

    const result = await tool.execute({ file_paths: ['/present/report.pdf', '/missing/report.pdf'] });

    expect(exists).toHaveBeenNthCalledWith(1, '/present/report.pdf');
    expect(exists).toHaveBeenNthCalledWith(2, '/missing/report.pdf');
    expect(result.error).toBe(true);
    expect(result.result).toBe('send_artifact: file(s) not found: /missing/report.pdf');
  });

  it('emits one MEDIA directive per existing file', async () => {
    const exists = vi.fn(() => true);
    const tool = new SendArtifactTool({ exists });

    const result = await tool.execute({ file_paths: [' /tmp/report.pdf ', '/tmp/image.png'] });

    expect(result.error).toBeUndefined();
    expect(result.name).toBe('send_artifact');
    expect(exists).toHaveBeenNthCalledWith(1, '/tmp/report.pdf');
    expect(exists).toHaveBeenNthCalledWith(2, '/tmp/image.png');
    expect(result.result).toBe(
      'Sending 2 file(s) through the channel:\n' +
      '/tmp/report.pdf\n/tmp/image.png\nMEDIA:/tmp/report.pdf\nMEDIA:/tmp/image.png',
    );
  });
});
