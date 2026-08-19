/**
 * Image generation tool bundle (plan image-gen).
 * Export surface for the discoverable `image_generate` tool.
 */

export {
  IMAGE_GENERATE_TOOL_NAME,
  ImageGenerateTool,
  imageGenerateTool,
} from './ImageGenerateTool.js';
export type {
  ImageGenerationConfig,
  ImageProvider,
} from './image-generation-config.js';
export {
  readImageGenerationConfig,
  getImageGenerationConfig,
  defaultImageOutputDir,
  resolveImageConfigRoot,
} from './image-generation-config.js';
export {
  generateImage,
  ImageGenerationError,
} from './provider.js';
export type {
  GenerateImageOptions,
  GeneratedImage,
} from './provider.js';
