import { describe, it, expect, vi } from 'vitest';
import { VisionTool } from '../VisionTool.js';
import type { ToolUseContext, ToolResult } from '../../../types.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

function makeContext(analyzeImage: (b64: string, mime: string, prompt?: string) => Promise<string>): ToolUseContext {
  return {
    options: { analyzeImage } as ToolUseContext['options'],
  } as ToolUseContext;
}

async function runWithError(message: string): Promise<ToolResult> {
  const tool = new VisionTool();
  const context = makeContext(vi.fn(async () => {
    throw new Error(message);
  }));
  return tool.execute({ image_path: PNG_DATA_URL }, undefined, context);
}

describe('VisionTool error guidance', () => {
  it('adds credentials guidance for auth errors (401)', async () => {
    const result = await runWithError('401 Missing Authentication header');
    expect(result.error).toBe(true);
    expect(result.result).toContain('API key/凭据无效或已过期');
    expect(result.result).toContain('设置 > 视觉模型');
  });

  it('adds network guidance for connection errors', async () => {
    const result = await runWithError('fetch failed: connect ECONNREFUSED 127.0.0.1:8000');
    expect(result.error).toBe(true);
    expect(result.result).toContain('无法连接视觉 provider');
    expect(result.result).toContain('端点地址与网络');
  });

  it('adds rate/quota guidance for 429 responses', async () => {
    const result = await runWithError('429 Too Many Requests: rate limit exceeded');
    expect(result.error).toBe(true);
    expect(result.result).toContain('限流或配额不足');
  });
});