/**
 * src/lib/providers/presets/custom.ts
 *
 * The "Custom" preset for arbitrary endpoints. This is the catch-all
 * the user falls back to when no preset matches.
 */

import type { ProviderPreset } from '../types';

export const CUSTOM_PRESETS: ProviderPreset[] = [
  {
    key: 'custom-anthropic',
    name: 'Custom Anthropic',
    description: 'Custom Anthropic-compatible endpoint',
    descriptionZh: '自定义 Anthropic 兼容端点',
    category: 'custom',
    apiFormat: 'anthropic',
    authFields: [
      { key: 'api_key', label: 'API Key', secret: true, required: true },
    ],
    defaultEndpoint: '',
    modelsSource: { type: 'openai-compatible-models', path: '/v1/models' },
    defaultModels: [],
    ui: { icon: 'server' },
    legacyProtocol: 'anthropic',
  },
  {
    key: 'custom-openai',
    name: 'Custom OpenAI',
    description: 'Custom OpenAI-compatible endpoint',
    descriptionZh: '自定义 OpenAI 兼容端点',
    category: 'custom',
    apiFormat: 'openai-chat',
    authFields: [
      { key: 'api_key', label: 'API Key', secret: true, required: true },
    ],
    defaultEndpoint: '',
    modelsSource: { type: 'openai-compatible-models', path: '/v1/models' },
    defaultModels: [],
    ui: { icon: 'server' },
    legacyProtocol: 'openai-compatible',
  },
];
