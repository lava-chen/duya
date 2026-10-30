#!/usr/bin/env node
/**
 * Refresh duya's per-provider model shards from public model directories.
 *
 * Why this exists: src/providers/<provider>.models.ts holds the built-in
 * capability directory for every model duya can talk to — context window,
 * max output, input modalities, reasoning flag, thinking ladder and
 * $/million-token pricing. Vendors rotate model names constantly, so the
 * directory drifts out of date and the preset seeds in catalog-data.ts stop
 * matching it (a preset id that no shard knows gets no context window and no
 * thinking ladder at runtime).
 *
 * Sources (both public, no API key):
 *   modelsdev   https://models.dev/api.json     (default — direct vendor ids)
 *   openrouter  https://openrouter.ai/api/v1/models
 *
 * Why models.dev is the default: it publishes the id the vendor's own
 * endpoint serves (`claude-sonnet-4-6`, `glm-5.3`, `MiniMax-M3`), which is
 * what duya's preset seeds must contain. OpenRouter publishes proxy-side ids
 * (`anthropic/claude-sonnet-4.6`) that only apply to the openrouter shard.
 *
 * Unit contract: `Model.cost` is $/MILLION tokens — the runtime reads it as
 * `inputPerMillion` (apps/desktop provider-store). models.dev already quotes
 * per-million; OpenRouter quotes per-token, so its numbers are scaled up.
 *
 * Governance contract: `compat` and `thinkingLevelMap` are hand-tuned per
 * model and survive every refresh. A refresh may add, drop or re-price
 * models; it never edits a thinking ladder or a wire-compat flag.
 *
 * Discovery vs. admission: every section scans its FULL upstream catalogue,
 * not just the ids already checked in. A new id is written only when it
 * passes the admission rules below (chat/tool-capable, recent, allowed
 * family); everything else upstream offers is reported as "held" with a
 * reason. Checked-in ids are never dropped for age — only when upstream stops
 * serving them (or an `exclude` rule matches).
 *
 * Admission rules for a new model (defaults for every section):
 *   - `tool_call === true`
 *   - `modalities.output` contains `text` and no audio/image/video
 *   - `modalities.input` contains `text`
 *   - not matched by the section's `exclude`
 *   - upstream does not mark it `status: "deprecated"`
 *   - `release_date` within RECENT_DAYS (default 45)
 *   - section `admitFamilies` (regex list) matches models.dev `family`
 *   - section `autoAdd: false` keeps the section report-only
 *
 * Modes:
 *   (default)   report — print upstream vs. checked-in deltas (no writes)
 *   --discover  explicit report-only mode (no writes)
 *   --diff      report + field-level changes for ids present on both sides
 *   --write     write: admitted new ids + checked-in ids upstream still serves
 *   --merge     write: refresh known ids, keep checked-in ids upstream dropped
 *   --only=a,b  restrict to a comma-separated shard subset
 *   --report=p  write a Chinese Markdown discovery report to `p`
 *
 * Test injection:
 *   SYNC_MODELS_FIXTURE_DIR  read modelsdev.json / openrouter.json from a dir
 *   SYNC_MODELS_PROVIDERS_DIR  read/write a copied shard tree instead of src/providers
 *   SYNC_MODELS_TODAY        override "today" (ISO date)
 *   SYNC_MODELS_RECENT_DAYS  override the admission window (default 45)
 *
 * Run:
 *   node packages/ai/scripts/sync-models.mjs
 *   node packages/ai/scripts/sync-models.mjs --diff --only=anthropic
 *   node packages/ai/scripts/sync-models.mjs --write --report=/tmp/report.md
 *   npm run sync:models -w @duya/ai -- --write
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const providersDir = join(__dirname, '..', 'src', 'providers');
// Test hook: point the read/write root at a copied shard tree so write-mode
// tests never touch the checked-in catalogue.
const PROVIDERS_DIR = process.env.SYNC_MODELS_PROVIDERS_DIR
  ? resolve(process.env.SYNC_MODELS_PROVIDERS_DIR)
  : providersDir;

const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

// ─── Shared thinking ladders ────────────────────────────────────────────────
// Anthropic-compatible endpoints take `thinking.budget_tokens`; the harness
// maps its own levels onto vendor names. Anthropic itself accepts
// off/low/medium/high; the Chinese token-plan endpoints add `max`.
const THINKING_ANTHROPIC =
  "thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' },";
const THINKING_ANTHROPIC_MAX =
  "thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' },";

// ─── Curated id selections ─────────────────────────────────────────────────
// models.dev groups list every alias a vendor ever shipped. duya only offers
// the ids a user can actually pick today, so each shard pins its selection
// here: `include` keeps a hand-picked list, `exclude` drops known noise.
const OPENAI_IDS = [
  'gpt-4o', 'gpt-4o-mini',
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'o1', 'o1-pro', 'o3', 'o3-pro', 'o3-mini', 'o4-mini',
  'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-pro',
  'gpt-5.1', 'gpt-5.2', 'gpt-5.2-pro', 'gpt-5.3-codex',
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.4-pro',
  'gpt-5.5', 'gpt-5.5-pro',
  'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol',
];

const GOOGLE_IDS = [
  'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite',
  'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite',
  'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash',
  'gemini-4-argon',
  'gemini-pro-latest', 'gemini-flash-latest',
];

// DashScope CN also serves GLM / Kimi / DeepSeek / MiniMax — those live in
// their own shards, so drop them here. Same for the math / translation /
// realtime aliases, which are not chat models.
const QWEN_EXCLUDE = [
  /^(glm|kimi|deepseek|MiniMax|siliconflow|moonshot)/,
  /math|doc-turbo|deep-research|character|asr|livetranslate|omni.*realtime|qwen-mt|qvq/,
  /qwen2-5-omni/,
];

// The Bailian coding plan serves Qwen, GLM, Kimi and MiniMax. Only the Qwen
// models are listed here: the other vendors' models are already described by
// their own shards, and listing them twice would give one model id two
// different output ceilings (the plan proxies them with its own caps).
const BAILIAN_IDS = [
  'qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-omni-flash',
  'qwen3.7-plus', 'qwen3.7-max', 'qwen3.6-plus', 'qwen3.5-plus',
  'qwen3.5-35b-a3b', 'qwen3-max-2026-01-23',
  'qwen3-coder-plus', 'qwen3-coder-next',
];

const BEDROCK_IDS = [
  'anthropic.claude-opus-5', 'anthropic.claude-opus-5-5',
  'anthropic.claude-sonnet-5', 'anthropic.claude-sonnet-5-5',
  'anthropic.claude-opus-4-8', 'anthropic.claude-opus-4-7',
  'anthropic.claude-opus-4-6-v1', 'anthropic.claude-opus-4-5-20251101-v1:0',
  'anthropic.claude-opus-4-1-20250805-v1:0',
  'anthropic.claude-sonnet-4-6', 'anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-haiku-5-5', 'anthropic.claude-haiku-4-5-20251001-v1:0',
  'anthropic.claude-fable-5', 'anthropic.claude-fable-5-1',
  'openai.gpt-6.1-sol', 'openai.gpt-6-sol', 'openai.gpt-6-astra',
  'openai.gpt-5.6-terra', 'openai.gpt-5.6-sol', 'openai.gpt-5.5', 'openai.gpt-5.4',
  'openai.gpt-oss-120b', 'openai.gpt-oss-20b',
  'amazon.nova-pro-v1:0', 'amazon.nova-2-lite-v1:0',
  'zai.glm-5', 'qwen.qwen3-coder-next', 'qwen.qwen3-235b-a22b-2507-v1:0',
  'moonshotai.kimi-k2.5', 'minimax.minimax-m2.5', 'minimax.minimax-m2.1',
  'deepseek.v3.2', 'xai.grok-4.6', 'xai.grok-4.3',
];

// OpenRouter proxies everything, so its shard is a flagship seed only — the
// provider fetches the full catalogue at runtime (`/api/v1/models`).
// OpenRouter names the 4.x generations with a dot (`claude-opus-4.7`) while
// models.dev names them with a dash; the ids here are OpenRouter's own.
const OPENROUTER_IDS = [
  'anthropic/claude-opus-5', 'anthropic/claude-sonnet-5',
  'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5',
  'anthropic/claude-fable-5', 'anthropic/claude-fable-5.1',
  'anthropic/claude-opus-4.8', 'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.6', 'anthropic/claude-opus-4.5',
  'anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4.5',
  'anthropic/claude-haiku-5.5', 'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.1',
  'openai/gpt-6.1-sol', 'openai/gpt-6.1-sol-pro',
  'openai/gpt-6-sol', 'openai/gpt-6-sol-pro',
  'openai/gpt-6-astra', 'openai/gpt-6-astra-pro',
  'openai/gpt-6-luna', 'openai/gpt-6-luna-pro',
  'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna',
  'openai/gpt-5.5', 'openai/gpt-5.5-pro',
  'openai/gpt-5.4', 'openai/gpt-5.4-mini', 'openai/gpt-5.4-nano', 'openai/gpt-5.4-pro',
  'openai/gpt-5.3-codex', 'openai/gpt-5.2', 'openai/gpt-5.2-pro',
  'openai/gpt-5.2-chat', 'openai/gpt-5.2-codex',
  'openai/gpt-5.1', 'openai/gpt-5.1-codex',
  'openai/gpt-5', 'openai/gpt-5-mini', 'openai/gpt-5-pro',
  'openai/gpt-4o', 'openai/gpt-4o-mini',
  'openai/gpt-4.1', 'openai/gpt-4.1-mini', 'openai/gpt-4.1-nano',
  'openai/o1', 'openai/o1-pro', 'openai/o3', 'openai/o3-pro',
  'openai/o3-mini', 'openai/o4-mini',
  'openai/gpt-oss-120b', 'openai/gpt-oss-20b',
  'google/gemini-4-argon', 'google/gemini-3.8-flash', 'google/gemini-3.7-flash',
  'google/gemini-3.6-flash', 'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-pro-preview', 'google/gemini-3.1-flash-lite',
  'google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'google/gemini-2.5-flash-lite',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v3.2', 'deepseek/deepseek-chat', 'deepseek/deepseek-r1-0528',
  'qwen/qwen3.8-max-prime', 'qwen/qwen3.8-omni-flash', 'qwen/qwen3.8-flash',
  'qwen/qwen3.8-27b', 'qwen/qwen3.7-plus', 'qwen/qwen3.7-max', 'qwen/qwen3.7-flash',
  'qwen/qwen3.6-plus', 'qwen/qwen3.6-flash',
  'qwen/qwen3.5-plus-20260420', 'qwen/qwen3.5-397b-a17b', 'qwen/qwen3.5-122b-a10b',
  'qwen/qwen3-coder-next', 'qwen/qwen3-coder-flash', 'qwen/qwen3-coder',
  'x-ai/grok-4.7', 'x-ai/grok-4.6', 'x-ai/grok-4.5', 'x-ai/grok-4.3',
  'x-ai/grok-4.20', 'x-ai/grok-4.20-multi-agent', 'x-ai/grok-build-0.1',
  'moonshotai/kimi-k3', 'moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k2.7-code',
  'moonshotai/kimi-k2.6', 'moonshotai/kimi-k2.5',
  'minimax/minimax-m3', 'minimax/minimax-m3.1-flash',
  'minimax/minimax-m2.7', 'minimax/minimax-m2.5', 'minimax/minimax-m2.1',
  'z-ai/glm-5.3', 'z-ai/glm-5.3-flash', 'z-ai/glm-5.2', 'z-ai/glm-5.1',
  'z-ai/glm-5', 'z-ai/glm-5-turbo', 'z-ai/glm-4.7',
  'stepfun/step-5-preview', 'stepfun/step-3.7-flash', 'stepfun/step-3.5-flash',
  'meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-large-4-0',
];

/**
 * Per-shard refresh configuration.
 *
 * `sections` — one entry per exported array in the file. A file may hold two
 * (glm.models.ts carries an openai-chat and an anthropic list).
 *
 * source: 'modelsdev' (group = models.dev slug) | 'openrouter' (prefix = the
 * OpenRouter vendor segment).
 *
 * mode: 'write' replaces the array with the upstream selection; 'merge'
 * refreshes the ids upstream still serves and keeps the checked-in ids it
 * dropped (used where duya's endpoint serves a hand-collected superset).
 */
const SHARDS = [
  {
    key: 'anthropic',
    file: 'anthropic.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// models.dev publishes the ids api.anthropic.com serves, which is what the
// preset seeds in catalog-data.ts contain — OpenRouter's proxy ids
// (claude-sonnet-4.6) do not exist on the direct endpoint.
// contextWindow / maxTokens / modalities / reasoning / pricing come from
// upstream metadata; compat and thinkingLevelMap are duya's own and survive
// every refresh.
`,
    sections: [
      {
        exportName: 'anthropicModels',
        api: 'anthropic',
        providerId: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        source: 'modelsdev',
        group: 'anthropic',
        // Dated snapshots (claude-sonnet-4-5-20250929) are aliases of the
        // rolling ids; the preset seeds use the rolling ones.
        exclude: [/-\d{8}$/],
        thinking: THINKING_ANTHROPIC,
      },
    ],
  },
  {
    key: 'openai',
    file: 'openai.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Chat Completions catalogue. Pricing is $/million tokens, the unit the
// runtime reads (provider-store maps Model.cost onto inputPerMillion).
`,
    sections: [
      {
        exportName: 'openAIModels',
        api: 'openai-chat',
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        source: 'modelsdev',
        group: 'openai',
        include: OPENAI_IDS,
        thinking: THINKING_ANTHROPIC,
        compat: "compat: { openAIThinkingFormat: 'openai-standard' },",
      },
    ],
  },
  {
    key: 'openai-responses',
    file: 'openai-responses.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Responses catalogue. Same model line as the Chat Completions shard;
// only the wire format differs, so the two files carry the same selection.
`,
    sections: [
      {
        exportName: 'openaiResponsesModels',
        api: 'openai-responses',
        providerId: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        source: 'modelsdev',
        group: 'openai',
        include: OPENAI_IDS,
        thinking: THINKING_ANTHROPIC,
        compat:
          "compat: { openAIThinkingFormat: 'reasoning-content', fixedTemperature: 1 },",
      },
    ],
  },
  {
    key: 'google',
    file: 'google.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// Gemini chat models. Image / TTS / live / embedding / research aliases are
// not chat models and are left out.
`,
    sections: [
      {
        exportName: 'googleModels',
        api: 'gemini',
        providerId: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        source: 'modelsdev',
        group: 'google',
        include: GOOGLE_IDS,
        // The Google group also lists non-Gemini entries; only the Gemini
        // family is a chat model duya offers.
        admitFamilies: [/^gemini/],
        thinking: THINKING_ANTHROPIC,
      },
    ],
  },
  {
    key: 'deepseek',
    file: 'deepseek.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
//
// api.deepseek.com serves exactly two ids: deepseek-flash (the V4.1 Flash
// line, which replaced the retired deepseek-v4-flash /
// deepseek-v4-flash-vision-exp ids) and deepseek-v4-pro.
//
// Pricing: DeepSeek bills off-peak (default, ~82% of hours) and peak (UTC
// Mon-Fri 01:00-04:00 and 06:00-10:00, 2x off-peak). Model.cost holds a
// single number per field, so the values below are off-peak rates; peak usage
// is 2x.
`,
    sections: [
      {
        exportName: 'deepseekModels',
        api: 'openai-chat',
        providerId: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        source: 'modelsdev',
        group: 'deepseek',
        include: ['deepseek-flash', 'deepseek-v4-pro'],
        compat:
          "compat: { openAIThinkingFormat: 'deepseek-style', requiresReasoningContentOnAssistantMessages: true },",
      },
    ],
  },
  {
    key: 'qwen',
    file: 'qwen.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The DashScope CN catalogue (dashscope.aliyuncs.com/compatible-mode/v1).
// DashScope also serves GLM / Kimi / DeepSeek / MiniMax — those live in their
// own shards, so they are filtered out here.
`,
    sections: [
      {
        exportName: 'qwenModels',
        api: 'openai-chat',
        providerId: 'qwen',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        source: 'modelsdev',
        group: ['alibaba-cn', 'alibaba'],
        exclude: QWEN_EXCLUDE,
      },
    ],
  },
  {
    key: 'kimi',
    file: 'kimi.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Moonshot global catalogue (api.moonshot.ai).
`,
    sections: [
      {
        exportName: 'kimiModels',
        api: 'openai-chat',
        providerId: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        source: 'modelsdev',
        group: ['moonshotai', 'moonshotai-cn'],
        compat: "compat: { openAIThinkingFormat: 'reasoning-content' },",
      },
    ],
  },
  {
    key: 'glm',
    file: 'glm.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
//
// Two catalogues live here: the pay-as-you-go OpenAI-compatible endpoint
// (open.bigmodel.cn/api/paas/v4) and the coding-plan Anthropic endpoint
// (open.bigmodel.cn/api/anthropic). They serve different model sets.
`,
    sections: [
      {
        exportName: 'glmModels',
        api: 'openai-chat',
        providerId: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        source: 'modelsdev',
        group: ['zhipuai', 'zai'],
        compat: "compat: { openAIThinkingFormat: 'glm-style' },",
        thinking: THINKING_ANTHROPIC,
      },
      {
        exportName: 'glmAnthropicModels',
        api: 'anthropic',
        providerId: 'glm',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
        source: 'modelsdev',
        group: ['zai-coding-plan', 'zai'],
        thinking: THINKING_ANTHROPIC_MAX,
      },
    ],
  },
  {
    key: 'minimax',
    file: 'minimax.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The MiniMax international token-plan catalogue (api.minimax.io/anthropic).
//
// MiniMax streams unsigned thinking fragments, so the endpoint accepts
// signature:"" on replayed blocks, and its thinking budget is adaptive rather
// than a fixed budget_tokens.
`,
    sections: [
      {
        exportName: 'minimaxModels',
        api: 'anthropic',
        providerId: 'minimax',
        baseUrl: 'https://api.minimax.io/anthropic',
        source: 'modelsdev',
        group: 'minimax-coding-plan',
        costGroup: 'minimax',
        thinking: THINKING_ANTHROPIC_MAX,
        compat: (id) =>
          `compat: { forceAdaptiveThinking: true, maxOutputTokens: ${
            id.startsWith('MiniMax-M3') ? 128000 : 131072
          }, allowEmptySignature: true },`,
      },
    ],
  },
  {
    key: 'minimax-cn',
    file: 'minimax-cn.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The MiniMax China token-plan catalogue (api.minimaxi.com/anthropic).
`,
    sections: [
      {
        exportName: 'minimaxCnModels',
        api: 'anthropic',
        providerId: 'minimax-cn',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        source: 'modelsdev',
        group: 'minimax-cn-coding-plan',
        costGroup: 'minimax-cn',
        thinking: THINKING_ANTHROPIC_MAX,
        compat: (id) =>
          `compat: { forceAdaptiveThinking: true, maxOutputTokens: ${
            id.startsWith('MiniMax-M3') ? 128000 : 131072
          }, allowEmptySignature: true },`,
      },
    ],
  },
  {
    key: 'xai',
    file: 'xai.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The xAI catalogue (api.x.ai). The imagine* entries are image/video models
// and are not chat models.
`,
    sections: [
      {
        exportName: 'xaiModels',
        api: 'anthropic',
        providerId: 'xai',
        baseUrl: 'https://api.x.ai/v1',
        source: 'modelsdev',
        group: 'xai',
        exclude: [/imagine/],
        thinking: THINKING_ANTHROPIC,
      },
    ],
  },
  {
    key: 'stepfun',
    file: 'stepfun.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Step Plan catalogue (api.stepfun.ai/step_plan/v1). step-router-v1 is a
// router, not a model, and the audio models are not chat models.
`,
    sections: [
      {
        exportName: 'stepfunModels',
        api: 'anthropic',
        providerId: 'stepfun',
        baseUrl: 'https://api.stepfun.ai/step_plan/v1',
        source: 'modelsdev',
        group: 'stepfun-step-plan',
        costGroup: 'stepfun',
        exclude: [/router|audio|tts|asr/],
        thinking: THINKING_ANTHROPIC,
      },
    ],
  },
  {
    key: 'volcengine',
    file: 'volcengine.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Volcengine Ark coding-plan catalogue
// (ark.cn-beijing.volces.com/api/coding): Doubao Seed plus the GLM / Kimi /
// DeepSeek / MiniMax models Ark resells under the plan.
`,
    sections: [
      {
        exportName: 'volcengineModels',
        api: 'anthropic',
        providerId: 'volcengine',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
        source: 'modelsdev',
        group: 'volcengine-coding-plan',
        costGroup: 'volcengine',
        thinking: THINKING_ANTHROPIC,
      },
    ],
  },
  {
    key: 'bailian',
    file: 'bailian.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Aliyun Bailian coding-plan catalogue
// (coding.dashscope.aliyuncs.com/apps/anthropic).
//
// 'merge' mode: the plan's own catalogue lists more than models.dev tracks,
// so ids upstream dropped are kept instead of deleted.
`,
    sections: [
      {
        exportName: 'bailianModels',
        api: 'anthropic',
        providerId: 'bailian',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
        source: 'modelsdev',
        group: 'alibaba-coding-plan',
        include: BAILIAN_IDS,
        fallbackGroup: ['alibaba-cn', 'alibaba'],
        // The plan also resells GLM / Kimi / MiniMax; those are described by
        // their own shards, so only the Qwen family is admitted here.
        admitFamilies: [/^qwen/],
        thinking: THINKING_ANTHROPIC_MAX,
      },
    ],
  },
  {
    key: 'xiaomi',
    file: 'xiaomi.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
// The Xiaomi MiMo catalogue (api.xiaomimimo.com/anthropic) and its token-plan
// sibling, which serve the same model line.
`,
    sections: [
      {
        exportName: 'xiaomiModels',
        api: 'anthropic',
        providerId: 'xiaomi',
        baseUrl: 'https://api.xiaomimimo.com/anthropic',
        source: 'modelsdev',
        group: ['xiaomi', 'xiaomi-token-plan-cn'],
        thinking: THINKING_ANTHROPIC_MAX,
      },
    ],
  },
  {
    key: 'bedrock',
    file: 'bedrock.models.ts',
    header: `// Model data. Sourced from https://models.dev/api.json (public, no key).
//
// AWS Bedrock ConverseStream catalogue. Model ids are Bedrock model IDs
// (<provider>.<name>); the region-prefixed aliases (us.*, eu.*, global.*)
// are the same models routed to one region, so only the unprefixed ids are
// listed. Pricing is per-million-tokens (USD) on the on-demand rate; see
// https://aws.amazon.com/bedrock/pricing/ for current values.
`,
    sections: [
      {
        exportName: 'bedrockModels',
        api: 'bedrock',
        providerId: 'bedrock',
        baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
        source: 'modelsdev',
        group: 'amazon-bedrock',
        include: BEDROCK_IDS,
        // Region-routed aliases (us.*, eu.*, global.*, ...) are the same model
        // as the unprefixed id; only the unprefixed ids belong in the shard.
        exclude: [/^(?:us|eu|apac|jp|ca|in|au|global|us-gov)\./],
        thinking: THINKING_ANTHROPIC_MAX,
      },
    ],
  },
  {
    key: 'openrouter',
    file: 'openrouter.models.ts',
    header: `// Model data. Sourced from https://openrouter.ai/api/v1/models (public,
// no key). OpenRouter is a no-auth model directory that proxies all the
// major vendors; the ids keep the upstream vendor prefix because that is
// what the endpoint serves. Pricing is converted from OpenRouter's per-token
// quotes to the per-million unit the runtime reads.
//
// This list is a flagship seed — the provider fetches the full catalogue at
// runtime from /api/v1/models.
`,
    sections: [
      {
        exportName: 'openrouterModels',
        api: 'openai-chat',
        providerId: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        source: 'openrouter',
        include: OPENROUTER_IDS,
        // The runtime fetches the full OpenRouter catalogue, so this shard is
        // an offline seed only: discovery reports new ids but never writes them.
        autoAdd: false,
      },
    ],
  },
];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

const MODE = has('--discover')
  ? 'report'
  : has('--write')
    ? 'write'
    : has('--merge')
      ? 'merge'
      : has('--diff')
        ? 'diff'
        : 'report';
const only = new Set(
  (valueOf('--only') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
const reportPath = valueOf('--report');

// Test / offline knobs. The fixture directory replaces both network fetches;
// TODAY and RECENT_DAYS make the admission window deterministic.
const FIXTURE_DIR = process.env.SYNC_MODELS_FIXTURE_DIR || undefined;
const TODAY = process.env.SYNC_MODELS_TODAY || new Date().toISOString().slice(0, 10);
const RECENT_DAYS =
  Number(process.env.SYNC_MODELS_RECENT_DAYS) > 0
    ? Number(process.env.SYNC_MODELS_RECENT_DAYS)
    : 45;

const round6 = (value) => Number(Number(value || 0).toFixed(6));

/**
 * Whether a pricing block actually carries a price.
 *
 * The subscription-plan groups (token plan, coding plan) publish an explicit
 * zero cost, which is not a price — the plan is a flat fee. Treating those
 * zeros as "free" would make every token-plan model look free at runtime.
 */
const hasPrice = (cost) => Boolean(cost && (cost.input || cost.output));

/** Normalise a pricing number to $/million tokens. */
const perMillion = (value) => round6((value || 0) * 1e6);

/** Accept a single group name or a list of them. */
const toArray = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/**
 * Order model ids by code unit, not by locale.
 *
 * `localeCompare` sorts through ICU collation, whose result depends on the
 * default locale of the process. The nightly refresh runs on a Linux runner
 * while the shards were written on a developer machine, so a locale-sensitive
 * order can turn "nothing changed upstream" into a whole-shard reordering
 * every single night. Code-unit order is the same on every machine and every
 * Node build, which is what makes the nightly job's "no change" early exit
 * mean what it says.
 */
function compareIds(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Whether the section's exclude rules drop this id.
 *
 * `include` is no longer a selection gate: discovery scans the whole upstream
 * group, and an include entry only pins an id for the "missing upstream"
 * report (and, for plan shards, lets it resolve through a fallback group).
 */
function excludedBySection(id, section) {
  for (const pattern of section.exclude ?? []) {
    if (typeof pattern === 'string' ? id === pattern : pattern.test(id)) return true;
  }
  return false;
}

/** Human-readable labels for the discovery report. */
const HELD_REASON_LABELS = {
  deprecated_upstream: '上游已标记 deprecated',
  no_tool_call: '不支持 tool_call',
  non_chat_output: '输出不是纯文本',
  no_text_input: '输入不含文本',
  family_not_admitted: '不在该 shard 准入的模型家族',
  outside_recency_window: '早于准入窗口',
  unknown_release_date: '缺发布日期',
  auto_add_disabled: '该 shard 只维护离线种子，运行时动态获取完整目录（不自动写入）',
};

/** models.dev publishes `release_date` as YYYY-MM-DD. */
function modelsDevReleaseDate(m) {
  return typeof m?.release_date === 'string' ? m.release_date : undefined;
}

/** OpenRouter publishes `created` as Unix seconds. */
function openRouterReleaseDate(entry) {
  if (typeof entry?.created === 'number' && Number.isFinite(entry.created)) {
    return new Date(entry.created * 1000).toISOString().slice(0, 10);
  }
  return undefined;
}

/** Whole days from `date` to `today`; NaN when either is unparseable. */
function daysSince(date, today) {
  const released = Date.parse(`${date}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(released) || !Number.isFinite(now)) return NaN;
  return Math.floor((now - released) / 86400000);
}

function isWithinRecencyWindow(date, today = TODAY, recentDays = RECENT_DAYS) {
  const days = daysSince(date, today);
  return Number.isFinite(days) && days <= recentDays;
}

/**
 * Admission decision for a new models.dev model. Returns the hold reason, or
 * `undefined` when the model may be written.
 */
function modelsDevHoldReason(section, m, releaseDate) {
  // models.dev keeps retired ids listed with `status: "deprecated"` (e.g.
  // deepseek-v4-flash, replaced by deepseek-flash). Those must never be
  // resurrected into the catalogue.
  if (m.status === 'deprecated') return 'deprecated_upstream';
  if (m.tool_call !== true) return 'no_tool_call';
  const output = m.modalities?.output ?? [];
  if (
    !output.includes('text') ||
    output.some((modality) => ['audio', 'image', 'video'].includes(modality))
  ) {
    return 'non_chat_output';
  }
  const input = m.modalities?.input ?? [];
  if (!input.includes('text')) return 'no_text_input';
  if (section.admitFamilies && !section.admitFamilies.some((re) => re.test(m.family ?? ''))) {
    return 'family_not_admitted';
  }
  if (!releaseDate) return 'unknown_release_date';
  if (!isWithinRecencyWindow(releaseDate)) return 'outside_recency_window';
  if (section.autoAdd === false) return 'auto_add_disabled';
  return undefined;
}

/** Admission decision for a new OpenRouter entry. */
function openRouterHoldReason(section, entry, releaseDate) {
  const params = entry.supported_parameters ?? [];
  if (!params.includes('tools')) return 'no_tool_call';
  const output = entry.architecture?.output_modalities ?? ['text'];
  if (
    !output.includes('text') ||
    output.some((modality) => ['audio', 'image', 'video'].includes(modality))
  ) {
    return 'non_chat_output';
  }
  const input = entry.architecture?.input_modalities ?? ['text'];
  if (!input.includes('text')) return 'no_text_input';
  if (!releaseDate) return 'unknown_release_date';
  if (!isWithinRecencyWindow(releaseDate)) return 'outside_recency_window';
  if (section.autoAdd === false) return 'auto_add_disabled';
  return undefined;
}

function buildCost(rates) {
  const cost = {
    input: rates.input,
    output: rates.output,
    cacheRead: rates.cacheRead,
    cacheWrite: rates.cacheWrite,
  };
  if (rates.tiers && rates.tiers.length > 0) cost.tiers = rates.tiers;
  return cost;
}

function mapModelsDev(section, id, m, pricing) {
  const input = m.modalities?.input ?? [];
  const tiers = (pricing?.tiers ?? [])
    .filter((tier) => tier.tier?.type === 'context' && tier.tier?.size !== undefined)
    .map((tier) => ({
      inputTokensAbove: tier.tier.size,
      input: round6(tier.input ?? 0),
      output: round6(tier.output ?? 0),
      cacheRead: round6(tier.cache_read ?? 0),
      cacheWrite: round6(tier.cache_write ?? 0),
    }))
    .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove);

  const model = {
    id,
    name: m.name || id,
    api: section.api,
    providerId: section.providerId,
    baseUrl: section.baseUrl,
    reasoning: m.reasoning === true,
    input: input.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: m.limit?.context ?? 0,
    maxTokens: m.limit?.output ?? 0,
  };

  // A model with no published price keeps the field absent — "unknown price"
  // and "free" are different answers, and the runtime treats an absent cost
  // as unknown.
  if (pricing) {
    model.cost = buildCost({
      input: round6(pricing.input ?? 0),
      output: round6(pricing.output ?? 0),
      cacheRead: round6(pricing.cache_read ?? 0),
      cacheWrite: round6(pricing.cache_write ?? 0),
      tiers,
    });
  }
  return model;
}

function mapOpenRouter(section, entry) {
  const id = entry.id;
  const ctx = entry.context_length ?? 0;
  const pricing = entry.pricing ?? {};
  const params = entry.supported_parameters ?? [];
  const modalities = entry.architecture?.input_modalities ?? [];
  return {
    id,
    name: entry.name || id,
    api: section.api,
    providerId: section.providerId,
    baseUrl: section.baseUrl,
    reasoning: params.includes('reasoning'),
    input: modalities.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: ctx,
    maxTokens: entry.top_provider?.max_completion_tokens ?? entry.max_completion_tokens ?? ctx,
    cost: buildCost({
      input: perMillion(pricing.prompt),
      output: perMillion(pricing.completion),
      cacheRead: perMillion(pricing.input_cache_read),
      cacheWrite: perMillion(pricing.input_cache_write),
    }),
  };
}

async function loadModelsDev() {
  if (FIXTURE_DIR) {
    return JSON.parse(readFileSync(join(FIXTURE_DIR, 'modelsdev.json'), 'utf8'));
  }
  const res = await fetch(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
  return res.json();
}

async function loadOpenRouter() {
  if (FIXTURE_DIR) {
    const raw = JSON.parse(readFileSync(join(FIXTURE_DIR, 'openrouter.json'), 'utf8'));
    return Array.isArray(raw) ? raw : raw.data;
  }
  const res = await fetch(OPENROUTER_URL);
  if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);
  return (await res.json()).data;
}

/**
 * Collect one section's upstream catalogue together with the admission
 * decision for every id.
 *
 * Returns:
 *   models   — ids to keep/write (checked-in ids upstream still serves, plus
 *              admitted new ids)
 *   missing  — pinned include ids upstream no longer provides
 *   admitted — new ids that passed the admission rules
 *   held     — new ids that did not, each with a reason and release date
 */
async function collectUpstream(section, sources, context) {
  const { checkedIn, today, recentDays } = context;
  const models = new Map();
  const missing = [];
  const admitted = [];
  const held = [];
  let candidateCount = 0;
  let excludedCount = 0;

  if (section.source === 'modelsdev') {
    // A shard may read several groups: the CN and the global catalogue of the
    // same vendor carry the same model line under slightly different ids, and
    // the union is what a user can actually pick.
    const groups = toArray(section.group);
    // Token-plan / coding-plan groups publish no per-token price (the plan is
    // a subscription), so the pay-as-you-go group of the same vendor supplies
    // the pricing.
    const costGroups = toArray(section.costGroup);
    // Groups consulted only for the ids an explicit selection names but the
    // primary group does not list (a plan's catalogue is spread over the
    // vendor's pay-as-you-go groups).
    const fallbackGroups = toArray(section.fallbackGroup);

    const primary = new Map();
    for (const groupName of groups) {
      const group = sources.modelsdev[groupName];
      if (!group?.models) throw new Error(`models.dev has no "${groupName}" group`);
      for (const [id, m] of Object.entries(group.models)) {
        if (!primary.has(id)) primary.set(id, m);
      }
    }
    const fallback = new Map();
    for (const groupName of fallbackGroups) {
      const group = sources.modelsdev[groupName];
      if (!group?.models) throw new Error(`models.dev has no "${groupName}" group`);
      for (const [id, m] of Object.entries(group.models)) {
        if (!fallback.has(id)) fallback.set(id, m);
      }
    }

    // Discovery covers every id the primary groups list. An include entry the
    // primary groups do not list resolves through a fallback group (plan
    // shards); when neither lists it, it is reported as missing.
    const raw = new Map(primary);
    candidateCount = raw.size;
    if (section.include) {
      for (const id of section.include) {
        if (raw.has(id)) continue;
        const m = fallback.get(id);
        if (!m) {
          missing.push(id);
          continue;
        }
        raw.set(id, m);
        candidateCount++;
      }
    }

    const select = (id, m) => {
      let pricing = hasPrice(m.cost) ? m.cost : undefined;
      if (!pricing) {
        for (const groupName of [...costGroups, ...fallbackGroups]) {
          const candidate = sources.modelsdev[groupName]?.models?.[id];
          if (hasPrice(candidate?.cost)) {
            pricing = candidate.cost;
            break;
          }
        }
      }
      models.set(id, mapModelsDev(section, id, m, pricing));
    };

    for (const [id, m] of raw) {
      const releaseDate = modelsDevReleaseDate(m);
      const excluded = excludedBySection(id, section);
      if (checkedIn.has(id)) {
        // A checked-in id is kept for as long as upstream still serves it —
        // never dropped merely because it is older than the admission window.
        if (!excluded) select(id, m);
        continue;
      }
      if (excluded) {
        excludedCount++;
        continue;
      }
      const reason = modelsDevHoldReason(section, m, releaseDate);
      if (reason) {
        held.push({ id, releaseDate, reason });
        continue;
      }
      select(id, m);
      admitted.push({ id, releaseDate });
    }
  } else {
    for (const entry of sources.openrouter) {
      const id = entry?.id;
      if (!id || id.includes(':') || id.includes('~')) continue;
      candidateCount++;
      const releaseDate = openRouterReleaseDate(entry);
      const excluded = excludedBySection(id, section);
      if (checkedIn.has(id)) {
        if (!excluded) models.set(id, mapOpenRouter(section, entry));
        continue;
      }
      if (excluded) {
        excludedCount++;
        continue;
      }
      const reason = openRouterHoldReason(section, entry, releaseDate);
      if (reason) {
        held.push({ id, releaseDate, reason });
        continue;
      }
      models.set(id, mapOpenRouter(section, entry));
      admitted.push({ id, releaseDate });
    }
  }

  // The report lists every held candidate: a model can be added to models.dev
  // long after release, so filtering older ids out would hide a late entry.
  // The renderer splits recent from older items to keep the actionable ones on
  // top, but nothing is dropped.
  return {
    models,
    missing,
    admitted,
    held,
    excludedCount,
    upstreamCount: candidateCount,
  };
}

/**
 * Pull one field (a `key: { ... }` object) out of a checked-in model block,
 * verbatim — including its trailing comma. Hand-tuned governance fields must
 * survive a refresh byte for byte.
 */
function extractField(block, key) {
  const startMatch = block.match(new RegExp(`\\n    ${key}: `));
  if (!startMatch) return undefined;
  let depth = 0;
  let started = false;
  let end = -1;
  for (let i = startMatch.index + 1; i < block.length; i++) {
    const c = block[i];
    if (c === '{') {
      depth++;
      started = true;
    } else if (c === '}') {
      depth--;
      if (started && depth === 0) {
        const comma = block.indexOf(',', i);
        end = comma === -1 ? i : comma;
        break;
      }
    }
  }
  if (end === -1) return undefined;
  return block.slice(startMatch.index + 1, end + 1).trim();
}

function modelBlock(m, { thinking, compat }) {
  const lines = [
    '  {',
    `    id: '${m.id}',`,
    `    name: ${JSON.stringify(m.name)},`,
    `    api: '${m.api}',`,
    `    providerId: '${m.providerId}',`,
    `    baseUrl: '${m.baseUrl}',`,
    `    reasoning: ${m.reasoning},`,
  ];
  if (thinking) lines.push(`    ${thinking}`);
  if (compat) lines.push(`    ${compat}`);
  lines.push(`    input: [${m.input.map((i) => `'${i}'`).join(', ')}],`);
  lines.push(`    contextWindow: ${m.contextWindow},`);
  lines.push(`    maxTokens: ${m.maxTokens},`);
  if (m.cost) {
    lines.push('    cost: {');
    lines.push(`      input: ${m.cost.input},`);
    lines.push(`      output: ${m.cost.output},`);
    lines.push(`      cacheRead: ${m.cost.cacheRead},`);
    lines.push(`      cacheWrite: ${m.cost.cacheWrite},`);
    if (m.cost.tiers) {
      lines.push('      tiers: [');
      for (const tier of m.cost.tiers) {
        lines.push(
          `        { inputTokensAbove: ${tier.inputTokensAbove}, input: ${tier.input}, output: ${tier.output}, cacheRead: ${tier.cacheRead}, cacheWrite: ${tier.cacheWrite} },`,
        );
      }
      lines.push('      ],');
    }
    lines.push('    },');
  }
  lines.push('  },');
  return lines.join('\n');
}

/** Read a checked-in shard: its line ending and, per exported array, its blocks. */
function readShard(file) {
  try {
    const src = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const sections = new Map();
    const re = /export const (\w+): Model<'[^']+'>\[\] = \[/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      const start = match.index + match[0].length;
      const end = src.indexOf('];', start);
      const body = src.slice(start, end === -1 ? src.length : end);
      const blocks = new Map();
      for (const blockMatch of body.matchAll(/\r?\n(  \{\r?\n[\s\S]*?\r?\n  \},)/g)) {
        const id = blockMatch[1].match(/id: '([^']+)'/)?.[1];
        if (id) blocks.set(id, blockMatch[1].replace(/\r\n/g, '\n'));
      }
      sections.set(match[1], blocks);
    }
    return { eol, sections };
  } catch {
    return { eol: '\n', sections: new Map() };
  }
}

function renderShard(shard, rendered) {
  const parts = [shard.header, `import type { Model } from '../types.js';\n`];
  for (const { section, blocks } of rendered) {
    parts.push(
      `\nexport const ${section.exportName}: Model<'${section.api}'>[] = [\n${blocks.join('\n')}\n];\n`,
    );
  }
  return parts.join('');
}

/**
 * Field-level differences between a checked-in block and the refreshed one.
 * Costs are compared per field so a re-price is readable; a tier change is
 * reported without recomputing every tier value.
 */
function describeChanges(before, after) {
  const changes = [];
  const pick = (block, key) => block.match(new RegExp(`\\n    ${key}: ([^\\n]+),`))?.[1];
  for (const key of ['contextWindow', 'maxTokens', 'reasoning']) {
    const a = pick(before, key);
    const b = pick(after, key);
    if (a !== undefined && b !== undefined && a !== b) changes.push(`${key} ${a}→${b}`);
  }

  const inputOf = (block) => {
    const match = block.match(/\n    input: \[([^\]]+)\],/);
    return match ? match[1].replace(/'/g, '').replace(/\s+/g, ' ').trim() : undefined;
  };
  const inputBefore = inputOf(before);
  const inputAfter = inputOf(after);
  if (inputBefore !== undefined && inputAfter !== undefined && inputBefore !== inputAfter) {
    changes.push(`input ${inputBefore}→${inputAfter}`);
  }

  const costBlock = (block) => block.match(/cost: \{([\s\S]*?)\n    \}/)?.[1];
  const costBefore = costBlock(before);
  const costAfter = costBlock(after);
  if ((costBefore === undefined) !== (costAfter === undefined)) {
    changes.push(costBefore === undefined ? 'cost 无→有' : 'cost 有→无');
  } else if (costBefore !== undefined) {
    const costField = (block, key) => block.match(new RegExp(`\\n      ${key}: (\\S+),`))?.[1];
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      const a = costField(before, key);
      const b = costField(after, key);
      if (a !== undefined && b !== undefined && a !== b) changes.push(`cost.${key} ${a}→${b}`);
    }
  }

  const tiersOf = (block) => block.match(/\n      tiers: \[([\s\S]*?)\n      \],/)?.[1];
  const tiersBefore = tiersOf(before);
  const tiersAfter = tiersOf(after);
  if (tiersBefore !== undefined && tiersAfter !== undefined && tiersBefore !== tiersAfter) {
    changes.push('cost.tiers');
  }

  return changes;
}

function heldReasonText(item) {
  return `${HELD_REASON_LABELS[item.reason] ?? item.reason}（${item.reason}）`;
}

function detailsBlock(summary, items) {
  return [
    '<details>',
    `<summary>${summary}</summary>`,
    '',
    ...(items.length ? items : ['无']),
    '',
    '</details>',
    '',
  ];
}

/** Chinese Markdown report: one section per shard export, full lists folded. */
function renderReport(entries) {
  const lines = [
    `# 模型目录发现报告（${TODAY}）`,
    '',
    '上游目录每天全量扫描；新模型需满足准入规则（上游未标记 deprecated、支持 tool_call、' +
      `输出纯文本、输入含文本、最近 ${RECENT_DAYS} 天发布）才会写入 shard。` +
      '已签入的 id 只要上游仍提供就保留。更早的未收录候选也会列出（上游可能在发布很久后补录），' +
      '是否加入由人工决定。自动收录仍走夜间 PR；目录校验通过后由 workflow 合并，异常时保留 PR。',
    '',
  ];

  for (const entry of entries) {
    const admittedItems = entry.admitted.map(
      (item) => `- \`${item.id}\` — ${item.releaseDate ?? '发布日期未知'}`,
    );
    const formatHeld = (item) =>
      `- \`${item.id}\` — ${item.releaseDate ?? '发布日期未知'} — 原因：${heldReasonText(item)}`;
    // Recent candidates are the ones the nightly run may admit tomorrow;
    // older ones stay visible so a late catalogue addition is never hidden.
    const recentHeld = entry.held.filter(
      (item) => !item.releaseDate || isWithinRecencyWindow(item.releaseDate),
    );
    const olderHeld = entry.held.filter(
      (item) => item.releaseDate && !isWithinRecencyWindow(item.releaseDate),
    );
    const removedItems = entry.removed.map((id) => `- \`${id}\``);
    const changedItems = entry.changed.map(
      (item) => `- \`${item.id}\`：${item.changes.join('；')}`,
    );

    lines.push(`## ${entry.shardKey} / ${entry.exportName}`, '');
    lines.push(`上游候选 ${entry.upstreamCount} 个，目录已签入 ${entry.checkedInCount} 个。`, '');
    if (entry.excludedCount > 0) {
      lines.push(`另有 ${entry.excludedCount} 个 id 按该 shard 的排除规则过滤（区域别名等）。`, '');
    }
    lines.push(...detailsBlock(`自动收录（${admittedItems.length}）`, admittedItems));
    lines.push(
      ...detailsBlock(`近期未收录（${recentHeld.length}）`, recentHeld.map(formatHeld)),
    );
    lines.push(
      ...detailsBlock(`更早未收录（${olderHeld.length}）`, olderHeld.map(formatHeld)),
    );
    lines.push(...detailsBlock(`上游下架（${removedItems.length}）`, removedItems));
    lines.push(...detailsBlock(`参数变化（${changedItems.length}）`, changedItems));
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

async function main() {
  const shards = SHARDS.filter((s) => only.size === 0 || only.has(s.key));
  if (shards.length === 0) {
    throw new Error(`no shard matched --only=${[...only].join(',')}`);
  }

  const needsModelsDev = shards.some((s) =>
    s.sections.some((section) => section.source === 'modelsdev'),
  );
  const needsOpenRouter = shards.some((s) =>
    s.sections.some((section) => section.source === 'openrouter'),
  );

  const sources = {
    modelsdev: needsModelsDev ? await loadModelsDev() : {},
    openrouter: needsOpenRouter ? await loadOpenRouter() : [],
  };

  let changeCount = 0;
  const reportEntries = [];

  for (const shard of shards) {
    const { eol, sections: checkedIn } = readShard(shard.file);
    const rendered = [];

    for (const section of shard.sections) {
      const existing = checkedIn.get(section.exportName) ?? new Map();
      const discovery = await collectUpstream(section, sources, {
        checkedIn: new Set(existing.keys()),
        today: TODAY,
        recentDays: RECENT_DAYS,
      });
      const { models: upstream, missing, admitted, held, excludedCount, upstreamCount } =
        discovery;
      const upstreamIds = new Set(upstream.keys());
      const removed = [...existing.keys()].filter((id) => !upstreamIds.has(id));
      const changed = [];

      console.log(
        `\n== ${shard.key}/${section.exportName}  (${upstreamCount} upstream candidates, ${existing.size} checked in)`,
      );
      if (admitted.length) {
        console.log(`   +${admitted.length}: ${admitted.map((item) => item.id).join(', ')}`);
      }
      if (removed.length) console.log(`   -${removed.length}: ${removed.join(', ')}`);
      const recentHeld = held.filter(
        (item) => !item.releaseDate || isWithinRecencyWindow(item.releaseDate),
      );
      if (recentHeld.length) {
        console.log(
          `   ? ${recentHeld.length} held: ${recentHeld
            .map((item) => `${item.id} (${item.reason})`)
            .join(', ')}`,
        );
      }
      if (held.length - recentHeld.length) {
        console.log(`   ? ${held.length - recentHeld.length} older held, listed in the report`);
      }
      if (excludedCount) console.log(`   ? ${excludedCount} excluded by this shard's rules`);
      if (missing.length) {
        console.log(`   ! pinned but not upstream: ${missing.join(', ')}`);
      }

      const blocks = [];
      const ids = [...upstream.keys()].sort(compareIds);
      for (const id of ids) {
        const model = upstream.get(id);
        const previous = existing.get(id);
        const thinking = previous ? extractField(previous, 'thinkingLevelMap') : section.thinking;
        const compat = previous
          ? extractField(previous, 'compat')
          : typeof section.compat === 'function'
            ? section.compat(id)
            : section.compat;
        const block = modelBlock(model, { thinking, compat });
        if (previous) {
          const changes = describeChanges(previous, block);
          if (changes.length) {
            changed.push({ id, changes });
            if (MODE === 'diff') console.log(`   ~ ${id}: ${changes.join(', ')}`);
          }
        }
        blocks.push(block);
      }

      if (MODE === 'write' || MODE === 'merge') {
        const sectionMode = section.mode ?? MODE;
        if (sectionMode === 'merge') {
          for (const [id, block] of existing) {
            if (!upstreamIds.has(id)) blocks.push(block);
          }
          blocks.sort((a, b) => {
            const idOf = (block) => block.match(/id: '([^']+)'/)?.[1] ?? '';
            return compareIds(idOf(a), idOf(b));
          });
        }
      }

      changeCount += admitted.length + removed.length;
      reportEntries.push({
        shardKey: shard.key,
        exportName: section.exportName,
        upstreamCount,
        checkedInCount: existing.size,
        admitted,
        held,
        excludedCount,
        removed,
        changed,
      });
      rendered.push({ section, blocks });
    }

    if (MODE === 'write' || MODE === 'merge') {
      const text = renderShard(shard, rendered);
      writeFileSync(
        join(PROVIDERS_DIR, shard.file),
        eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text,
      );
      console.log(`   wrote src/providers/${shard.file}`);
    }
  }

  if (reportPath) {
    const target = resolve(reportPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderReport(reportEntries));
    console.log(`   report written to ${target}`);
  }

  if (MODE !== 'report') console.log(`\n${changeCount} id-level change(s) detected.`);
}

main().catch((err) => {
  console.error(`sync-models failed: ${err.message}`);
  process.exitCode = 1;
});
