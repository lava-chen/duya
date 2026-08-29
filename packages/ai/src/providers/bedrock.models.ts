// Model data. Hand-curated as the base; generated (models.dev) fields fill gaps.
//
// Plan 451 Phase 6: AWS Bedrock ConverseStream model catalog.
// Model ids are Bedrock model IDs (`<provider>.<name>-<version>`).
// Pricing is per-million-tokens (USD) on the Bedrock on-demand rate;
// see https://aws.amazon.com/bedrock/pricing/ for current values.
import type { Model } from '../types.js';

export const bedrockModels: Model<'bedrock'>[] = [
  {
    id: 'anthropic.claude-sonnet-4-20250514-v1:0',
    name: 'Claude Sonnet 4 (Bedrock)',
    api: 'bedrock',
    providerId: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 64000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: 'anthropic.claude-opus-4-20250514-v1:0',
    name: 'Claude Opus 4 (Bedrock)',
    api: 'bedrock',
    providerId: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    id: 'anthropic.claude-3-5-haiku-20241022-v1:0',
    name: 'Claude 3.5 Haiku (Bedrock)',
    api: 'bedrock',
    providerId: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
    cost: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
  {
    id: 'amazon.nova-pro-v1:0',
    name: 'Amazon Nova Pro (Bedrock)',
    api: 'bedrock',
    providerId: 'bedrock',
    baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    reasoning: false,
    input: ['text', 'image'],
    contextWindow: 300000,
    maxTokens: 5120,
    cost: { input: 0.8, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
  },
];