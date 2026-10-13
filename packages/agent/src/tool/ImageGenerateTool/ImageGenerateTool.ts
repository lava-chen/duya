import {
  IMAGE_GENERATE_DESCRIPTION as DESCRIPTION,
  IMAGE_GENERATE_TOOL_NAME,
  ImageGenerateTool as CapabilityImageGenerateTool,
} from '@duya/capabilities';
import type { ImageGenerationPort } from '@duya/capabilities';
import { getImageGenerationConfig } from './image-generation-config.js';
import { generateImage as generateWithProvider } from './provider.js';

export { DESCRIPTION, IMAGE_GENERATE_TOOL_NAME };

const agentImageGenerationPort: ImageGenerationPort = {
  async generate(request) {
    const config = getImageGenerationConfig();
    const generated = await generateWithProvider(config, {
      prompt: request.prompt,
      size: request.size,
      quality: request.quality,
      referenceImage: request.referenceImage,
      outputDir: request.outputDir,
    });

    return { ...generated, configuredSize: config.size };
  },
};

/** Compatibility adapter. Configuration and provider execution remain Agent-owned for CLI consumers. */
export class ImageGenerateTool extends CapabilityImageGenerateTool {
  constructor(imageGeneration: ImageGenerationPort = agentImageGenerationPort) {
    super(imageGeneration);
  }
}

export const imageGenerateTool = new ImageGenerateTool();
