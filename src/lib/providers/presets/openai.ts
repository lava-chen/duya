/**
 * src/lib/providers/presets/openai.ts
 *
 * OpenAI-compatible presets. These all use apiFormat: 'openai-chat' and
 * Bearer auth. Includes OpenAI official and OpenAI-compatible aggregators
 * (OpenRouter, Bailian, etc.).
 */

import type { ProviderPreset } from '../types';

const BEARER_AUTH_FIELDS = [
  { key: 'api_key', label: 'API Key', secret: true, required: true },
];

export const OPENAI_PRESETS: ProviderPreset[] = [
  {
    key: 'openai-official',
    name: 'OpenAI',
    description: "OpenAI's official API",
    descriptionZh: 'OpenAI 官方 API',
    category: 'official',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://api.openai.com/v1',
    modelsSource: { type: 'openai-compatible-models', path: '/models' },
    defaultModels: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3-mini'],
    ui: {
      icon: 'openai',
      iconColor: '#00A67E',
      websiteUrl: 'https://platform.openai.com',
      apiKeyUrl: 'https://platform.openai.com/api-keys',
    },
    legacyProtocol: 'openai',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 100+ models via OpenRouter',
    descriptionZh: '通过 OpenRouter 访问 100+ 模型',
    category: 'aggregator',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    modelsSource: { type: 'openai-compatible-models', path: '/models' },
    defaultModels: [
      'anthropic/claude-3.5-sonnet',
      'anthropic/claude-3-opus',
      'anthropic/claude-3-haiku',
    ],
    ui: {
      icon: 'openrouter',
      websiteUrl: 'https://openrouter.ai',
      apiKeyUrl: 'https://openrouter.ai/keys',
    },
    legacyProtocol: 'openrouter',
  },
  {
    key: 'openai-compatible-generic',
    name: 'OpenAI-compatible API',
    description: 'Generic OpenAI-compatible endpoint — provide URL and Key',
    descriptionZh: 'OpenAI 兼容端点 — 填写地址和密钥',
    category: 'custom',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: '',
    modelsSource: { type: 'openai-compatible-models', path: '/models' },
    defaultModels: [],
    ui: {
      icon: 'server',
    },
    legacyProtocol: 'openai-compatible',
  },

  // ── LiteLLM proxy ──
  // LiteLLM is a self-hosted OpenAI-compatible proxy that fronts
  // many providers. Default endpoint assumes the standard local
  // install (http://localhost:4000). Users should override.
  {
    key: 'litellm',
    name: 'LiteLLM Proxy',
    description: 'LiteLLM self-hosted OpenAI-compatible proxy',
    descriptionZh: 'LiteLLM 自托管 OpenAI 兼容代理',
    category: 'aggregator',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'http://localhost:4000',
    modelsSource: { type: 'openai-compatible-models', path: '/v1/models' },
    defaultModels: [],
    ui: {
      icon: 'server',
      websiteUrl: 'https://github.com/BerriAI/litellm',
      docsUrl: 'https://docs.litellm.ai/',
    },
    legacyProtocol: 'openai-compatible',
  },
];
