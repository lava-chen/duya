/**
 * Provider Presets
 * Single source of truth for quick-add provider configurations
 *
 * Based on hermes-agent's models_dev.py and CodePilot's provider-catalog.ts
 *
 * NOTE: Brand icons are NOT imported here to avoid SSR issues with @lobehub/icons.
 * Consumers should use the iconKey field and resolve icons themselves using
 * getPresetIcon() helper from their own components with proper icon imports.
 */

import type { ReactNode } from "react";
import { GlobeIcon } from "@/components/icons";

// ── Types ───────────────────────────────────────────────────────

export type Protocol =
  | 'anthropic'
  | 'openai-compatible'
  | 'openrouter'
  | 'bedrock'
  | 'vertex'
  | 'google'
  | 'gemini-image'
  | 'ollama';

export type AuthStyle =
  | 'api_key'
  | 'auth_token'
  | 'env_only'
  | 'custom_header';

export interface CatalogModel {
  modelId: string;
  upstreamModelId?: string;
  displayName: string;
}

export interface VendorPreset {
  key: string;
  name: string;
  description: string;
  descriptionZh: string;
  protocol: Protocol;
  authStyle: AuthStyle;
  baseUrl: string;
  defaultEnvOverrides: Record<string, string>;
  defaultModels: CatalogModel[];
  fields: ('name' | 'api_key' | 'base_url' | 'extra_env' | 'model_names' | 'model_mapping')[];
  category?: 'chat' | 'media';
  iconKey: string;
  sdkProxyOnly?: boolean;
  meta?: {
    apiKeyUrl?: string;
    docsUrl?: string;
    pricingUrl?: string;
    statusPageUrl?: string;
    billingModel?: 'pay_as_you_go' | 'coding_plan' | 'token_plan' | 'free' | 'self_hosted';
    notes?: string[];
  };
}

export interface QuickPreset extends VendorPreset {
  provider_type: string;
}

// ── Vendor presets ──────────────────────────────────────────────

export const VENDOR_PRESETS: VendorPreset[] = [
  // ── Official Anthropic ──
  {
    key: 'anthropic-official',
    name: 'Anthropic',
    description: "Anthropic's official Claude API",
    descriptionZh: 'Anthropic 官方 Claude API',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.anthropic.com',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { modelId: 'claude-opus-4-7', displayName: 'Claude Opus 4.7' },
      { modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
    ],
    fields: ['api_key'],
    iconKey: 'anthropic',
    meta: {
      apiKeyUrl: 'https://console.anthropic.com/',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Anthropic Third-party (generic) ──
  {
    key: 'anthropic-thirdparty',
    name: 'Anthropic Third-party API',
    description: 'Anthropic-compatible API — provide URL and Key',
    descriptionZh: 'Anthropic 兼容第三方 API — 填写地址和密钥',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: '',
    defaultEnvOverrides: { ANTHROPIC_API_KEY: '' },
    defaultModels: [
      { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
    ],
    fields: ['name', 'api_key', 'base_url', 'extra_env', 'model_mapping'],
    iconKey: 'server',
  },

  // ── OpenRouter ──
  {
    key: 'openrouter',
    name: 'OpenRouter',
    description: 'Access 100+ models via OpenRouter',
    descriptionZh: '通过 OpenRouter 访问 100+ 模型',
    protocol: 'openrouter',
    authStyle: 'auth_token',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'anthropic/claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet' },
      { modelId: 'anthropic/claude-3-opus', displayName: 'Claude 3 Opus' },
      { modelId: 'anthropic/claude-3-haiku', displayName: 'Claude 3 Haiku' },
    ],
    fields: ['api_key'],
    iconKey: 'openrouter',
    meta: {
      apiKeyUrl: 'https://openrouter.ai/keys',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── DeepSeek ──
  {
    key: 'deepseek',
    name: 'DeepSeek',
    description: 'DeepSeek Anthropic-compatible API — V4 Pro / V4 Flash',
    descriptionZh: 'DeepSeek Anthropic 兼容 API — V4 Pro / V4 Flash',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.deepseek.com/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    defaultModels: [
      { modelId: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
      { modelId: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
      { modelId: 'deepseek-chat', displayName: 'DeepSeek Chat' },
      { modelId: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
    ],
    fields: ['api_key'],
    iconKey: 'deepseek',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.deepseek.com/api_keys',
      docsUrl: 'https://platform.deepseek.com/docs',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Zhipu GLM (China) ──
  {
    key: 'glm-cn',
    name: 'GLM (CN)',
    description: 'Zhipu GLM Code Plan — China region',
    descriptionZh: '智谱 GLM 编程套餐 — 中国区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
    },
    defaultModels: [
      { modelId: 'glm-5.1', displayName: 'GLM-5.1' },
      { modelId: 'glm-5', displayName: 'GLM-5' },
      { modelId: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
      { modelId: 'glm-5v-turbo', displayName: 'GLM-5V Turbo' },
      { modelId: 'glm-4.7', displayName: 'GLM-4.7' },
      { modelId: 'glm-4.5', displayName: 'GLM-4.5' },
      { modelId: 'glm-4.5-flash', displayName: 'GLM-4.5 Flash' },
      { modelId: 'glm-4.5-air', displayName: 'GLM-4.5 Air' },
    ],
    fields: ['api_key'],
    iconKey: 'zhipu',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      docsUrl: 'https://docs.bigmodel.cn/cn/coding-plan/tool/claude',
      billingModel: 'coding_plan',
      notes: ['高峰时段（14:00-18:00 UTC+8）消耗 3 倍积分'],
    },
  },

  // ── Zhipu GLM (Global) ──
  {
    key: 'glm-global',
    name: 'GLM (Global)',
    description: 'Zhipu GLM Code Plan — Global region',
    descriptionZh: '智谱 GLM 编程套餐 — 国际区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.z.ai/api/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
    },
    defaultModels: [
      { modelId: 'glm-5.1', displayName: 'GLM-5.1' },
      { modelId: 'glm-5', displayName: 'GLM-5' },
      { modelId: 'glm-5-turbo', displayName: 'GLM-5 Turbo' },
      { modelId: 'glm-5v-turbo', displayName: 'GLM-5V Turbo' },
      { modelId: 'glm-4.7', displayName: 'GLM-4.7' },
      { modelId: 'glm-4.5', displayName: 'GLM-4.5' },
      { modelId: 'glm-4.5-flash', displayName: 'GLM-4.5 Flash' },
      { modelId: 'glm-4.5-air', displayName: 'GLM-4.5 Air' },
    ],
    fields: ['api_key'],
    iconKey: 'zhipu',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
      docsUrl: 'https://docs.z.ai/devpack/tool/claude',
      billingModel: 'coding_plan',
      notes: ['高峰时段（14:00-18:00 UTC+8）消耗 3 倍积分'],
    },
  },

  // ── Kimi ──
  {
    key: 'kimi',
    name: 'Kimi',
    description: 'Kimi Coding Plan API',
    descriptionZh: 'Kimi 编程计划 API',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'https://api.kimi.com/coding/',
    defaultEnvOverrides: { ENABLE_TOOL_SEARCH: 'false' },
    defaultModels: [
      { modelId: 'kimi-k2.6', displayName: 'Kimi K2.6' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
      { modelId: 'kimi-k2', displayName: 'Kimi K2' },
      { modelId: 'kimi-k2-thinking', displayName: 'Kimi K2 Thinking' },
      { modelId: 'kimi-k2-thinking-turbo', displayName: 'Kimi K2 Thinking Turbo' },
      { modelId: 'kimi-k2-turbo-preview', displayName: 'Kimi K2 Turbo Preview' },
      { modelId: 'kimi-k2-0905-preview', displayName: 'Kimi K2 Preview (0905)' },
    ],
    fields: ['api_key'],
    iconKey: 'kimi',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://www.kimi.com/code/console',
      docsUrl: 'https://www.kimi.com/code/docs/more/third-party-agents.html',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Moonshot ──
  {
    key: 'moonshot',
    name: 'Moonshot',
    description: 'Moonshot AI API',
    descriptionZh: '月之暗面 API',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    defaultEnvOverrides: { ENABLE_TOOL_SEARCH: 'false' },
    defaultModels: [
      { modelId: 'kimi-k2.6', displayName: 'Kimi K2.6' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
      { modelId: 'kimi-k2', displayName: 'Kimi K2' },
      { modelId: 'kimi-k2-thinking', displayName: 'Kimi K2 Thinking' },
      { modelId: 'kimi-k2-thinking-turbo', displayName: 'Kimi K2 Thinking Turbo' },
      { modelId: 'kimi-k2-turbo-preview', displayName: 'Kimi K2 Turbo Preview' },
      { modelId: 'kimi-k2-0905-preview', displayName: 'Kimi K2 Preview (0905)' },
    ],
    fields: ['api_key'],
    iconKey: 'moonshot',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.moonshot.cn/console/api-keys',
      docsUrl: 'https://platform.moonshot.cn/docs/guide/agent-support',
      billingModel: 'pay_as_you_go',
      notes: ['建议设置每日消费上限，防止 agentic 循环快速消耗 token'],
    },
  },

  // ── StepFun Step Plan ──
  {
    key: 'stepfun',
    name: 'StepFun Step Plan',
    description: 'StepFun Step Plan — Fast reasoning and coding',
    descriptionZh: '阶跃星辰 Step Plan — 快速推理与编程',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.stepfun.ai/step_plan/v1',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
    },
    defaultModels: [
      { modelId: 'step-3.5-flash', displayName: 'Step-3.5 Flash' },
      { modelId: 'step-3.5-flash-2603', displayName: 'Step-3.5 Flash (2603)' },
    ],
    fields: ['api_key'],
    iconKey: 'stepfun',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.stepfun.com/api',
      docsUrl: 'https://platform.stepfun.com/docs',
      billingModel: 'coding_plan',
    },
  },

  // ── MiniMax (China) ──
  {
    key: 'minimax-cn',
    name: 'MiniMax (CN)',
    description: 'MiniMax Code Plan — China region',
    descriptionZh: 'MiniMax 编程套餐 — 中国区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    defaultModels: [
      { modelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' },
      { modelId: 'MiniMax-M2.5', displayName: 'MiniMax-M2.5' },
      { modelId: 'MiniMax-M2.1', displayName: 'MiniMax-M2.1' },
      { modelId: 'MiniMax-M2', displayName: 'MiniMax-M2' },
    ],
    fields: ['api_key'],
    iconKey: 'minimax',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.minimaxi.com/user-center/payment/token-plan',
      docsUrl: 'https://platform.minimaxi.com/docs/token-plan/claude-code',
      billingModel: 'token_plan',
      notes: ['中国区用户专用，需要 MiniMax 编程套餐订阅'],
    },
  },

  // ── MiniMax (Global) ──
  {
    key: 'minimax-global',
    name: 'MiniMax (Global)',
    description: 'MiniMax Code Plan — Global region',
    descriptionZh: 'MiniMax 编程套餐 — 国际区',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.minimax.io/anthropic',
    defaultEnvOverrides: {
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    defaultModels: [
      { modelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' },
      { modelId: 'MiniMax-M2.5', displayName: 'MiniMax-M2.5' },
      { modelId: 'MiniMax-M2.1', displayName: 'MiniMax-M2.1' },
      { modelId: 'MiniMax-M2', displayName: 'MiniMax-M2' },
    ],
    fields: ['api_key'],
    iconKey: 'minimax',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.minimax.io/user-center/payment/token-plan',
      docsUrl: 'https://platform.minimax.io/docs/token-plan/opencode',
      billingModel: 'token_plan',
    },
  },

  // ── Volcengine Ark ──
  {
    key: 'volcengine',
    name: 'Volcengine Ark',
    description: 'Volcengine Ark Coding Plan — Doubao, GLM, DeepSeek, Kimi',
    descriptionZh: '字节火山方舟 Coding Plan — 豆包、GLM、DeepSeek、Kimi',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'doubao-1.5-pro-32k', displayName: 'Doubao 1.5 Pro 32K' },
      { modelId: 'doubao-1.5-lite-32k', displayName: 'Doubao 1.5 Lite 32K' },
      { modelId: 'doubao-pro-32k', displayName: 'Doubao Pro 32K' },
      { modelId: 'doubao-lite-32k', displayName: 'Doubao Lite 32K' },
      { modelId: 'deepseek-v3-241226', displayName: 'DeepSeek V3 (241226)' },
      { modelId: 'deepseek-r1-250120', displayName: 'DeepSeek R1 (250120)' },
      { modelId: 'glm-4-9b-chat', displayName: 'GLM-4 9B Chat' },
      { modelId: 'glm-4-flash', displayName: 'GLM-4 Flash' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
    ],
    fields: ['api_key', 'model_names'],
    iconKey: 'volcengine',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement',
      docsUrl: 'https://www.volcengine.com/docs/82379/1928262',
      billingModel: 'coding_plan',
      notes: ['需先在控制台激活 Endpoint', 'API Key 为临时凭证'],
    },
  },

  // ── Xiaomi MiMo (按量付费) ──
  {
    key: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    description: 'Xiaomi MiMo Pay-as-you-go API — MiMo-V2.5-Pro',
    descriptionZh: '小米 MiMo 按量付费 — MiMo-V2.5-Pro',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'mimo-v2.5-pro', displayName: 'MiMo-V2.5-Pro' },
      { modelId: 'mimo-v2.5', displayName: 'MiMo-V2.5' },
      { modelId: 'mimo-v2-pro', displayName: 'MiMo-V2-Pro' },
      { modelId: 'mimo-v2-omni', displayName: 'MiMo-V2-Omni' },
      { modelId: 'mimo-v2-flash', displayName: 'MiMo-V2-Flash' },
    ],
    fields: ['api_key'],
    iconKey: 'xiaomi',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/api-keys',
      docsUrl: 'https://platform.xiaomimimo.com/#/docs/integration/claudecode',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Xiaomi MiMo Token Plan ──
  {
    key: 'xiaomi-mimo-token-plan',
    name: 'Xiaomi MiMo Token Plan',
    description: 'Xiaomi MiMo Token Plan subscription',
    descriptionZh: '小米 MiMo Token Plan 订阅套餐',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'mimo-v2.5-pro', displayName: 'MiMo-V2.5-Pro' },
      { modelId: 'mimo-v2.5', displayName: 'MiMo-V2.5' },
      { modelId: 'mimo-v2-pro', displayName: 'MiMo-V2-Pro' },
      { modelId: 'mimo-v2-omni', displayName: 'MiMo-V2-Omni' },
    ],
    fields: ['api_key'],
    iconKey: 'xiaomi',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://platform.xiaomimimo.com/#/console/plan-manage',
      docsUrl: 'https://platform.xiaomimimo.com/#/docs/integration/claudecode',
      billingModel: 'token_plan',
    },
  },

  // ── xAI Grok ──
  {
    key: 'xai',
    name: 'xAI Grok',
    description: 'xAI Grok — Fast reasoning models',
    descriptionZh: 'xAI Grok — 快速推理模型',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.x.ai/v1',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'grok-4.20-reasoning', displayName: 'Grok 4.20 Reasoning' },
      { modelId: 'grok-4-1-fast-reasoning', displayName: 'Grok 4-1 Fast Reasoning' },
    ],
    fields: ['api_key'],
    iconKey: 'xai',
    meta: {
      apiKeyUrl: 'https://console.x.ai/',
      docsUrl: 'https://docs.x.ai/docs',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Arcee ──
  {
    key: 'arcee',
    name: 'Arcee',
    description: 'Arcee AI — Trinity Large Thinking models',
    descriptionZh: 'Arcee AI — Trinity 大型推理模型',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://api.arcee.ai/api/v1',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'trinity-large-thinking', displayName: 'Trinity Large Thinking' },
      { modelId: 'trinity-large-preview', displayName: 'Trinity Large Preview' },
      { modelId: 'trinity-mini', displayName: 'Trinity Mini' },
    ],
    fields: ['api_key'],
    iconKey: 'arcee',
    meta: {
      apiKeyUrl: 'https://www.arcee.ai/',
      docsUrl: 'https://docs.arcee.ai/',
      billingModel: 'pay_as_you_go',
    },
  },

  // ── Aliyun Bailian ──
  {
    key: 'bailian',
    name: 'Aliyun Bailian',
    description: 'Aliyun Bailian Coding Plan — Qwen, GLM, Kimi, MiniMax',
    descriptionZh: '阿里云百炼 Coding Plan — 通义千问、GLM、Kimi、MiniMax',
    protocol: 'anthropic',
    authStyle: 'auth_token',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'qwen3.6-plus', displayName: 'Qwen 3.6 Plus' },
      { modelId: 'qwen3.5-plus', displayName: 'Qwen 3.5 Plus' },
      { modelId: 'qwen3.5-plus-02-15', displayName: 'Qwen 3.5 Plus (02-15)' },
      { modelId: 'qwen3.5-35b-a3b', displayName: 'Qwen 3.5 35B A3B' },
      { modelId: 'qwen3-coder-next', displayName: 'Qwen 3 Coder Next' },
      { modelId: 'qwen3-coder-plus', displayName: 'Qwen 3 Coder Plus' },
      { modelId: 'qwen3-coder', displayName: 'Qwen 3 Coder' },
      { modelId: 'kimi-k2.6', displayName: 'Kimi K2.6' },
      { modelId: 'kimi-k2.5', displayName: 'Kimi K2.5' },
      { modelId: 'kimi-k2-thinking', displayName: 'Kimi K2 Thinking' },
      { modelId: 'glm-5.1', displayName: 'GLM-5.1' },
      { modelId: 'glm-5', displayName: 'GLM-5' },
      { modelId: 'glm-4.7', displayName: 'GLM-4.7' },
      { modelId: 'MiniMax-M2.7', displayName: 'MiniMax-M2.7' },
      { modelId: 'MiniMax-M2.5', displayName: 'MiniMax-M2.5' },
    ],
    fields: ['api_key'],
    iconKey: 'bailian',
    sdkProxyOnly: true,
    meta: {
      apiKeyUrl: 'https://bailian.console.aliyun.com',
      docsUrl: 'https://help.aliyun.com/zh/model-studio/coding-plan',
      billingModel: 'coding_plan',
      notes: ['必须使用 Coding Plan 专用 Key（以 sk-sp- 开头）', '普通 DashScope Key 无法使用', '禁止用于自动化脚本'],
    },
  },

  // ── AWS Bedrock ──
  {
    key: 'bedrock',
    name: 'AWS Bedrock',
    description: 'Amazon Bedrock — requires AWS credentials',
    descriptionZh: 'Amazon Bedrock — 需要 AWS 凭证',
    protocol: 'bedrock',
    authStyle: 'env_only',
    baseUrl: '',
    defaultEnvOverrides: {
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'us-east-1',
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    },
    defaultModels: [
      { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
    ],
    fields: ['extra_env'],
    iconKey: 'bedrock',
    meta: {
      apiKeyUrl: 'https://console.aws.amazon.com',
      docsUrl: 'https://aws.amazon.com/cn/bedrock/anthropic/',
      billingModel: 'pay_as_you_go',
      notes: ['需在 AWS Console 订阅 Claude 模型'],
    },
  },

  // ── Google Vertex AI ──
  {
    key: 'vertex',
    name: 'Google Vertex',
    description: 'Google Vertex AI — requires GCP credentials',
    descriptionZh: 'Google Vertex AI — 需要 GCP 凭证',
    protocol: 'vertex',
    authStyle: 'env_only',
    baseUrl: '',
    defaultEnvOverrides: {
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: 'us-east5',
      CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
    },
    defaultModels: [
      { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
    ],
    fields: ['extra_env'],
    iconKey: 'google',
    meta: {
      docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/use-claude',
      billingModel: 'pay_as_you_go',
      notes: ['需启用 Vertex AI 并在 Model Garden 订阅 Claude 模型'],
    },
  },

  // ── Ollama ──
  {
    key: 'ollama',
    name: 'Ollama',
    description: 'Ollama — run local models with native API',
    descriptionZh: 'Ollama — 本地运行模型，原生 API',
    protocol: 'ollama',
    authStyle: 'auth_token',
    baseUrl: 'http://localhost:11434',
    defaultEnvOverrides: {
      OPENAI_API_KEY: 'ollama',
    },
    defaultModels: [
      { modelId: 'llama3.2', displayName: 'Llama 3.2' },
      { modelId: 'qwen2.5', displayName: 'Qwen 2.5' },
      { modelId: 'codellama', displayName: 'CodeLlama' },
      { modelId: 'mistral', displayName: 'Mistral' },
      { modelId: 'deepseek-coder', displayName: 'DeepSeek Coder' },
    ],
    fields: ['base_url', 'model_names'],
    iconKey: 'ollama',
    meta: {
      docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
      billingModel: 'free',
      notes: [
        '需要本地安装 Ollama (https://ollama.com)',
        '使用 Ollama 原生 API 端点 (非 OpenAI 兼容模式)',
        '支持工具调用和思考内容',
        'API Key 可填写任意值，本地运行无需验证',
        '不确定能运行什么模型？用 CanIRun.ai 检测: https://www.canirun.ai/',
      ],
    },
  },

  // ── LiteLLM ──
  {
    key: 'litellm',
    name: 'LiteLLM',
    description: 'LiteLLM proxy — local or remote',
    descriptionZh: 'LiteLLM 代理 — 本地或远程',
    protocol: 'anthropic',
    authStyle: 'api_key',
    baseUrl: 'http://localhost:4000',
    defaultEnvOverrides: {},
    defaultModels: [
      { modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
      { modelId: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
    ],
    fields: ['api_key', 'base_url'],
    iconKey: 'server',
    meta: {
      docsUrl: 'https://docs.litellm.ai/docs/',
      billingModel: 'self_hosted',
    },
  },
];

// ── Convert to QuickPreset ──────────────────────────────────────

function toQuickPreset(vp: VendorPreset): QuickPreset {
  return {
    ...vp,
    provider_type: vp.protocol === 'openrouter' ? 'openrouter'
      : vp.protocol === 'bedrock' ? 'bedrock'
      : vp.protocol === 'vertex' ? 'vertex'
      : vp.protocol === 'gemini-image' ? 'gemini-image'
      : vp.protocol === 'ollama' ? 'ollama'
      : vp.protocol === 'openai-compatible' ? 'openai-compatible'
      : 'anthropic',
  };
}

export const QUICK_PRESETS: QuickPreset[] = VENDOR_PRESETS.map(toQuickPreset);

export function getPreset(key: string): QuickPreset | undefined {
  return QUICK_PRESETS.find((p) => p.key === key);
}

/**
 * Find a matching preset for a provider by base_url
 */
export function findPresetByBaseUrl(baseUrl: string): QuickPreset | undefined {
  if (!baseUrl) return undefined;
  const urlLower = baseUrl.toLowerCase();
  return QUICK_PRESETS.find(p => {
    if (!p.baseUrl) return false;
    return p.baseUrl.toLowerCase() === urlLower || urlLower.includes(p.baseUrl.toLowerCase());
  });
}

/**
 * Get icon component for a preset by iconKey.
 * Consumer must import this function and use their own @lobehub/icons imports.
 *
 * Example usage in a component:
 *   import Anthropic from "@lobehub/icons/es/Anthropic";
 *   import OpenRouter from "@lobehub/icons/es/OpenRouter";
 *   const icon = getPresetIcon(preset.iconKey, { anthropic: <Anthropic size={18} />, openrouter: <OpenRouter size={18} />, ... });
 */
export function getPresetIcon(iconKey: string, iconMap: Record<string, ReactNode>): ReactNode {
  return iconMap[iconKey] ?? <GlobeIcon size={18} />;
}
