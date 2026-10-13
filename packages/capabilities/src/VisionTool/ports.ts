export interface VisionImageSourceRequest {
  readonly source: string;
  readonly label: string;
  readonly hintedMimeType: string | null;
  readonly workingDirectory?: string;
}

export interface ResolvedVisionImageSource {
  readonly label: string;
  readonly resolvedPath: string | null;
  readonly base64Data: string;
  readonly mimeType: string | null;
  readonly fileSizeBytes: number;
}

export type VisionAnalyzeCallback = (
  base64Data: string,
  mimeType: string,
  prompt?: string,
) => Promise<string>;

/** Host boundary for loading an image and optionally analyzing it. */
export interface VisionAnalysisPort {
  loadImageSource(request: VisionImageSourceRequest): Promise<ResolvedVisionImageSource>;
  analyzeImage?: VisionAnalyzeCallback;
}
