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

  // ── MiniMax OpenAI-compatible (dual-protocol, spec §9) ──
  // MiniMax offers both Anthropic-compatible (/anthropic) and
  // OpenAI-compatible (/v1) endpoints. These presets use the
  // OpenAI path. @duya/ai resolves compat: { openAIThinkingFormat:
  // 'reasoning-content' } for MiniMax-M3 via findModelCompat.
  {
    key: 'minimax-openai-cn',
    name: 'MiniMax (OpenAI, CN)',
    description: 'MiniMax via OpenAI-compatible API — China region',
    descriptionZh: 'MiniMax OpenAI 兼容接口 — 中国区',
    category: 'aggregator',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://api.minimaxi.com/v1',
    modelsSource: { type: 'static' },
    defaultModels: ['MiniMax-M3'],
    ui: {
      icon: 'minimax',
      iconColor: '#FF6B6B',
      websiteUrl: 'https://platform.minimaxi.com',
      apiKeyUrl: 'https://platform.minimaxi.com/user-center/payment/token-plan',
    },
    legacyProtocol: 'openai-compatible',
  },
  {
    key: 'minimax-openai-global',
    name: 'MiniMax (OpenAI, Global)',
    description: 'MiniMax via OpenAI-compatible API — Global region',
    descriptionZh: 'MiniMax OpenAI 兼容接口 — 国际区',
    category: 'aggregator',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://api.minimax.io/v1',
    modelsSource: { type: 'static' },
    defaultModels: ['MiniMax-M3'],
    ui: {
      icon: 'minimax',
      iconColor: '#FF6B6B',
      websiteUrl: 'https://platform.minimax.io',
      apiKeyUrl: 'https://www.minimax.io/platform-center/api-keys',
    },
    legacyProtocol: 'openai-compatible',
  },

  // ── Domestic OpenAI-compatible providers (compat via @duya/ai) ──
  // findModelCompat('openai-chat', modelId) resolves the correct
  // openAIThinkingFormat for each provider's reasoning output format.
  {
    key: 'deepseek-openai',
    name: 'DeepSeek',
    description: 'DeepSeek API (OpenAI-compatible)',
    descriptionZh: 'DeepSeek API (OpenAI 兼容)',
    category: 'official',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://api.deepseek.com/v1',
    modelsSource: { type: 'static' },
    defaultModels: ['deepseek-reasoner', 'deepseek-chat'],
    defaultModelLabels: {
      'deepseek-reasoner': 'DeepSeek R1 (Reasoning)',
      'deepseek-chat': 'DeepSeek V3 (Chat)',
    },
    ui: {
      icon: 'deepseek',
      websiteUrl: 'https://platform.deepseek.com',
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    },
    legacyProtocol: 'openai-compatible',
  },
  {
    key: 'qwen-openai',
    name: 'Qwen (DashScope)',
    description: 'Alibaba Qwen via DashScope OpenAI-compatible API',
    descriptionZh: '阿里通义千问 DashScope OpenAI 兼容接口',
    category: 'official',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    modelsSource: { type: 'static' },
    defaultModels: ['qwq-32b-preview'],
    ui: {
      icon: 'qwen',
      websiteUrl: 'https://dashscope.console.aliyun.com',
      apiKeyUrl: 'https://dashscope.console.aliyun.com/apiKey',
    },
    legacyProtocol: 'openai-compatible',
  },
  {
    key: 'glm-openai',
    name: 'GLM (Zhipu)',
    description: 'Zhipu GLM via OpenAI-compatible API',
    descriptionZh: '智谱 GLM OpenAI 兼容接口',
    category: 'official',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://open.bigmodel.cn/api/paas/v4',
    modelsSource: { type: 'static' },
    defaultModels: ['glm-4-plus'],
    ui: {
      icon: 'zhipu',
      websiteUrl: 'https://open.bigmodel.cn',
      apiKeyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    },
    legacyProtocol: 'openai-compatible',
  },
  {
    key: 'kimi-openai',
    name: 'Kimi (Moonshot)',
    description: 'Moonshot Kimi via OpenAI-compatible API',
    descriptionZh: '月之暗面 Kimi OpenAI 兼容接口',
    category: 'official',
    apiFormat: 'openai-chat',
    authFields: BEARER_AUTH_FIELDS,
    defaultEndpoint: 'https://api.moonshot.cn/v1',
    modelsSource: { type: 'static' },
    defaultModels: ['moonshot-v1-auto'],
    ui: {
      icon: 'kimi',
      websiteUrl: 'https://platform.moonshot.cn',
      apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
    },
    legacyProtocol: 'openai-compatible',
  },
];
