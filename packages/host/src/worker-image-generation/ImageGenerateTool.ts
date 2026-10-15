import {
  IMAGE_GENERATE_DESCRIPTION as DESCRIPTION,
  IMAGE_GENERATE_TOOL_NAME,
  ImageGenerateTool as CapabilityImageGenerateTool,
} from '@duya/capabilities';
import type { ImageGenerationPort } from '@duya/capabilities';
import { getImageGenerationConfig } from './image-generation-config.js';
import { generateImage as generateWithProvider } from './provider.js';

export { DESCRIPTION, IMAGE_GENERATE_TOOL_NAME };

const workerImageGenerationPort: ImageGenerationPort = {
  async generate(request) {
    const config = getImageGenerationConfig();
    const generated = await generateWithProvider(config, {
      prompt: request.prompt,
      ...(request.size === undefined ? {} : { size: request.size }),
      ...(request.quality === undefined ? {} : { quality: request.quality }),
      ...(request.referenceImage === undefined ? {} : { referenceImage: request.referenceImage }),
      ...(request.outputDir === undefined ? {} : { outputDir: request.outputDir }),
    });

    return { ...generated, configuredSize: config.size };
  },
};

/** Bind the reusable capability to Host configuration and provider effects. */
export class ImageGenerateTool extends CapabilityImageGenerateTool {
  constructor(imageGeneration: ImageGenerationPort = workerImageGenerationPort) {
    super(imageGeneration);
  }
}

export const imageGenerateTool = new ImageGenerateTool();
