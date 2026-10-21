export type ImageGenerationQuality = 'auto' | 'low' | 'medium' | 'high';

export interface ImageGenerationRequest {
  prompt: string;
  size?: string;
  quality?: ImageGenerationQuality;
  referenceImage?: string;
  outputDir?: string;
}

/** The result data needed by the tool-facing message and metadata. */
export interface ImageGenerationPortResult {
  filePath: string;
  bytes: number;
  mimeType: string;
  width?: number;
  height?: number;
  provider: string;
  model: string;
  durationMs: number;
  configuredSize: string;
}

/** Provider/config IO stays with the caller; the capability only shapes the tool contract. */
export interface ImageGenerationPort {
  generate(request: ImageGenerationRequest): Promise<ImageGenerationPortResult>;
}
