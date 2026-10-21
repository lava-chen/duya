import { describe, expect, it, vi } from 'vitest';
import {
  DESCRIPTION,
  IMAGE_GENERATE_TOOL_NAME,
  ImageGenerateTool,
} from '../../src/ImageGenerateTool/ImageGenerateTool.js';
import type {
  ImageGenerationPort,
  ImageGenerationPortResult,
  ImageGenerationRequest,
} from '../../src/ImageGenerateTool/ports.js';

const generatedImage: ImageGenerationPortResult = {
  filePath: 'C:/duya/media/generated/image.png',
  bytes: 2048,
  mimeType: 'image/png',
  width: 1024,
  height: 768,
  provider: 'openai',
  model: 'gpt-image-1',
  durationMs: 1200,
  configuredSize: '1024x1024',
};

describe('ImageGenerateTool capability', () => {
  it('retains the tool schema and usage prompt', () => {
    const tool = new ImageGenerateTool({ generate: async () => generatedImage });
    const schema = tool.input_schema as { required?: string[]; properties?: Record<string, unknown> };

    expect(tool.name).toBe(IMAGE_GENERATE_TOOL_NAME);
    expect(tool.description).toBe(DESCRIPTION);
    expect(schema.required).toEqual(['prompt']);
    expect(Object.keys(schema.properties ?? {})).toEqual([
      'prompt',
      'size',
      'quality',
      'reference_image',
      'output_path',
    ]);
    expect(tool.getPrompt()).toContain('image_generate usage guide');
    expect(tool.getPrompt()).toContain('reference_image');
  });

  it('normalizes input and assembles the success result and metadata', async () => {
    let received: ImageGenerationRequest | undefined;
    const port: ImageGenerationPort = {
      async generate(request) {
        received = request;
        return generatedImage;
      },
    };
    const tool = new ImageGenerateTool(port);

    const result = await tool.execute({
      prompt: '  a fox in a greenhouse  ',
      size: ' 1536x1024 ',
      quality: 'high',
      reference_image: '  C:/reference.png ',
      output_path: '  C:/generated ',
    });

    expect(received).toEqual({
      prompt: 'a fox in a greenhouse',
      size: '1536x1024',
      quality: 'high',
      referenceImage: 'C:/reference.png',
      outputDir: 'C:/generated',
    });
    expect(result).toMatchObject({
      name: IMAGE_GENERATE_TOOL_NAME,
      result: expect.stringContaining('Image generated: C:/duya/media/generated/image.png'),
      metadata: {
        filePath: generatedImage.filePath,
        mimeType: generatedImage.mimeType,
        bytes: generatedImage.bytes,
        width: generatedImage.width,
        height: generatedImage.height,
        provider: generatedImage.provider,
        model: generatedImage.model,
        durationMs: generatedImage.durationMs,
      },
    });
    expect(result.result).toContain('Size: 1024x768px');
    expect(result.result).toContain('2.0 KB | image/png');
  });

  it('uses the configured size when the provider omits dimensions', async () => {
    const tool = new ImageGenerateTool({
      generate: async () => ({ ...generatedImage, width: undefined, height: undefined }),
    });

    const result = await tool.execute({ prompt: 'landscape' });

    expect(result.result).toContain('Size: 1024x1024');
  });

  it('returns provider failures as tool errors', async () => {
    const tool = new ImageGenerateTool({
      generate: async () => {
        throw new Error('provider rate limit');
      },
    });

    const result = await tool.execute({ prompt: 'a cat' });

    expect(result).toMatchObject({
      name: IMAGE_GENERATE_TOOL_NAME,
      result: 'Error: provider rate limit',
      error: true,
    });
  });
});
