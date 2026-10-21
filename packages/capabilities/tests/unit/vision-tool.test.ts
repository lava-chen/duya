import { describe, expect, it, vi } from 'vitest';
import { VisionTool } from '../../src/VisionTool/VisionTool.js';
import type { ToolUseContext } from '../../src/contracts/tool.js';
import type {
  ResolvedVisionImageSource,
  VisionAnalysisPort,
  VisionImageSourceRequest,
} from '../../src/VisionTool/ports.js';

const loadedImage: ResolvedVisionImageSource = {
  label: 'diagram.png',
  resolvedPath: '/workspace/diagram.png',
  base64Data: 'aW1hZ2U=',
  mimeType: 'image/png',
  fileSizeBytes: 512,
};

function makePort() {
  const loadImageSource = vi.fn(async (_request: VisionImageSourceRequest) => loadedImage);
  const analyzeImage = vi.fn(async (_base64: string, _mimeType: string, _prompt?: string) => 'A diagram with two boxes.');
  const port: VisionAnalysisPort = { loadImageSource, analyzeImage };
  return { port, loadImageSource, analyzeImage };
}

describe('VisionTool', () => {
  it('loads an explicit image through the injected port and preserves result metadata', async () => {
    const { port, loadImageSource, analyzeImage } = makePort();
    const tool = new VisionTool(port);
    const result = await tool.execute(
      { image_path: 'images/diagram.png', question: 'How many boxes?' },
      '/workspace',
      { toolUseId: 'tool-1' } as ToolUseContext,
    );

    expect(loadImageSource).toHaveBeenCalledWith({
      source: 'images/diagram.png',
      label: 'images/diagram.png',
      hintedMimeType: null,
      workingDirectory: '/workspace',
    });
    expect(analyzeImage).toHaveBeenCalledWith(
      'aW1hZ2U=',
      'image/png',
      'Answer the following question about this image: "How many boxes?"\n\nProvide a clear and thorough answer based on what you see in the image.',
    );
    // A successful analysis carries no error flag at all: VisionTool omits the
    // optional `error` field on success and only sets it to true on failures.
    expect(result.error).toBeUndefined();
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({
      name: 'vision_analyze',
      metadata: {
        imagePath: '/workspace/diagram.png',
        mimeType: 'image/png',
        imageSizeBytes: 512,
      },
    });
    expect(result.result).toContain('Image analyzed: /workspace/diagram.png');
    expect(result.result).toContain('Question: How many boxes?');
    expect(result.result).toContain('A diagram with two boxes.');
  });

  it('uses the newest attachment and falls back to the run analysis callback', async () => {
    const loadImageSource = vi.fn(async (_request: VisionImageSourceRequest) => loadedImage);
    const port: VisionAnalysisPort = { loadImageSource };
    const analyzeImage = vi.fn(async () => 'The latest uploaded image.');
    const context = {
      toolUseId: 'tool-2',
      options: {
        recentImageAttachments: [
          { name: 'latest.png', path: '/uploads/latest.png', type: 'image/png' },
          { name: 'older.png', path: '/uploads/older.png', type: 'image/png' },
        ],
        analyzeImage,
      },
    } as unknown as ToolUseContext;

    const result = await new VisionTool(port).execute({}, undefined, context);

    expect(loadImageSource).toHaveBeenCalledWith({
      source: '/uploads/latest.png',
      label: 'latest.png',
      hintedMimeType: 'image/png',
    });
    expect(analyzeImage).toHaveBeenCalledWith('aW1hZ2U=', 'image/png', undefined);
    expect(result.result).toContain('The latest uploaded image.');
  });

  it('returns actionable guidance when the injected analyzer rejects', async () => {
    const { port } = makePort();
    port.analyzeImage = vi.fn(async () => {
      throw new Error('401 invalid API key');
    });

    const result = await new VisionTool(port).execute({ image_path: 'diagram.png' });

    expect(result.error).toBe(true);
    expect(result.result).toContain('API key/凭据无效或已过期');
    expect(result.result).toContain('设置 > 视觉模型');
  });

  it('returns a clear error when no image path or recent attachment exists', async () => {
    const { port, loadImageSource, analyzeImage } = makePort();
    const result = await new VisionTool(port).execute({});

    expect(result.error).toBe(true);
    expect(result.result).toContain('No image source was provided');
    expect(loadImageSource).not.toHaveBeenCalled();
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});
