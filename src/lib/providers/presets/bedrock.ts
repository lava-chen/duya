/**
 * src/lib/providers/presets/bedrock.ts
 *
 * AWS Bedrock preset. Wired as apiFormat 'bedrock' so future SDK
 * integration has a stable discriminator.
 */

import type { ProviderPreset } from '../types';

export const BEDROCK_PRESETS: ProviderPreset[] = [
  {
    key: 'aws-bedrock',
    name: 'AWS Bedrock',
    description: 'AWS Bedrock — Claude, Llama, Mistral models',
    descriptionZh: 'AWS Bedrock — Claude、Llama、Mistral 模型',
    category: 'managed',
    apiFormat: 'bedrock',
    authFields: [
      { key: 'api_key', label: 'Bearer Token', secret: true, required: true },
    ],
    defaultEndpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    modelsSource: { type: 'static' },
    defaultModels: [
      'anthropic.claude-sonnet-4-5-20251001-v1:0',
      'anthropic.claude-3-5-sonnet-20241022-v2:0',
    ],
    ui: {
      icon: 'bedrock',
      websiteUrl: 'https://aws.amazon.com/bedrock',
    },
    legacyProtocol: 'bedrock',
  },
];
