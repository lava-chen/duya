/**
 * VisualAnalysisService — encapsulates the optional vision model client
 * (`visionClient` + `visionConfig`) and the `analyzeImage` flow extracted
 * from DuyaAgent. The service is self-contained: DuyaAgent delegates to it
 * via `this.visualAnalysis.analyzeImage.bind(this.visualAnalysis)`.
 */
import { findModelCompat } from '@duya/ai';
import type { ApiFormat } from '@duya/ai';
import { createAIClient, inferProvider } from '@duya/ai';
import type { AIClient } from '@duya/ai';
import { logger } from '../utils/logger.js';
import type { ImageContent, Message, VisionConfig } from '../types.js';

type Provider = 'anthropic' | 'openai' | 'ollama';

export class VisualAnalysisService {
  private visionClient?: AIClient;
  private visionConfig?: VisionConfig;

  constructor(
    visionConfig: VisionConfig | undefined,
    private readonly getDefaultBaseURL: (provider: Provider) => string,
  ) {
    logger.info(`[VisualAnalysis] Vision config check: enabled=${visionConfig?.enabled}, provider=${visionConfig?.provider}, model=${visionConfig?.model}, baseURL=${visionConfig?.baseURL}`);
    if (!visionConfig?.enabled) {
      logger.info(`[VisualAnalysis] Vision model NOT initialized - disabled or not configured`);
      return;
    }
    this.visionConfig = visionConfig;
    const visionProvider = inferProvider(visionConfig.baseURL || '', visionConfig.provider);
    logger.info(`[VisualAnalysis] Vision provider inferred: provider=${visionConfig.provider}, baseURL=${visionConfig.baseURL} -> resolved=${visionProvider}`);
    try {
      // Resolve apiFormat + modelCompat so vision requests also flow
      // through the @duya/ai protocol layer. Without these flags,
      // reasoning-capable vision models (GLM-4V, Qwen-VL, etc.) would
      // not get their reasoning_content parsed correctly.
      const visionApiFormat: ApiFormat = visionProvider === 'anthropic' ? 'anthropic' : 'openai-chat';
      const visionModelCompat = findModelCompat(visionApiFormat, visionConfig.model);
      this.visionClient = createAIClient({
        apiKey: visionConfig.apiKey,
        baseURL: visionConfig.baseURL || this.getDefaultBaseURL(visionProvider),
        model: visionConfig.model,
        apiFormat: visionApiFormat,
        providerId: visionConfig.provider,
        modelCapabilities: visionModelCompat,
      });
      logger.info(`[VisualAnalysis] Vision model initialized: ${visionConfig.model} (resolved provider: ${visionProvider})`);
    } catch (err) {
      logger.warn(`[VisualAnalysis] Failed to initialize vision model: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get isAvailable(): boolean {
    return !!this.visionClient;
  }

  /**
   * Analyze an image using the configured vision model.
   * Returns text description of the image.
   * Throws an error if vision is unavailable or the API call fails.
   */
  async analyzeImage(imageBase64: string, mediaType: string, customPrompt?: string): Promise<string> {
    logger.debug('[VisualAnalysis] analyzeImage called', {
      hasVisionClient: !!this.visionClient,
      visionConfig: this.visionConfig,
      imageBase64Length: imageBase64.length,
      mediaType,
      customPrompt: customPrompt?.substring(0, 100),
    });

    if (!this.visionClient) {
      logger.warn('[VisualAnalysis] analyzeImage: No vision client configured');
      throw new Error('Vision model is not configured. Please configure a vision model in Settings > Vision Model.');
    }

    const prompt = customPrompt || 'Please describe this image in detail. What do you see? Include any text, colors, shapes, objects, people, and the overall scene.';

    const userMessage: Message = {
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType as ImageContent['source']['media_type'], data: imageBase64 },
        },
      ],
    };

    const result: string[] = [];
    let lastError: string | null = null;
    try {
      logger.debug('[VisualAnalysis] Starting vision stream');
      const stream = this.visionClient.streamChat([userMessage], {
        maxTokens: 2048,
        temperature: 0,
      });

      let eventCount = 0;
      for await (const event of stream) {
        eventCount++;
        logger.debug(`[VisualAnalysis] Vision stream event: ${event.type} (${eventCount})`);
        if (event.type === 'text') {
          result.push(event.data);
          logger.debug(`[VisualAnalysis] Vision text event: ${event.data?.substring(0, 100)}`);
        }
        if (event.type === 'error') {
          lastError = event.data as string;
          logger.debug(`[VisualAnalysis] Vision stream error event: ${lastError}`);
          break;
        }
        if (event.type === 'done') {
          logger.debug('[VisualAnalysis] Vision stream ended: done');
          break;
        }
      }
      logger.debug(`[VisualAnalysis] Vision stream finished, events: ${eventCount}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`[VisualAnalysis] Vision analysis failed: ${errMsg}`);
      throw new Error(`Vision model API error: ${errMsg}`);
    }

    if (lastError) {
      throw new Error(`Vision model returned an error: ${lastError}`);
    }

    const analysis = result.join('').trim();
    logger.info(`[VisualAnalysis] Vision analysis complete: ${analysis.length} chars`);

    if (!analysis) {
      throw new Error('Vision model returned empty analysis. The model may not support image input, or the image format may be unsupported.');
    }

    return analysis;
  }
}
