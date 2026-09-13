#!/usr/bin/env node
/**
 * Sync duya's per-provider model shards from a public model directory.
 *
 * Why this exists: src/providers/<provider>.models.ts holds a curated snapshot
 * of each vendor's models — context window, max output, input modalities,
 * reasoning flag and $/token cost. Vendors rotate model names and context
 * sizes constantly (e.g. DeepSeek renamed `deepseek-v4-flash` to
 * `deepseek-flash` and retired the legacy ids). This script pulls the current
 * upstream metadata so the params duya needs can be refreshed in one pass.
 *
 * Sources (both public, no API key):
 *   openrouter  https://openrouter.ai/api/v1/models   (default)
 *   modelsdev   https://models.dev/api.json           (--source=modelsdev)
 *
 * Upstream metadata is mapped into duya's `Model` shape:
 *   contextWindow <- context_length
 *   maxTokens     <- top_provider.max_completion_tokens
 *   input         <- architecture.input_modalities ('image' -> text + image)
 *   reasoning     <- supported_parameters includes 'reasoning'
 *   cost          <- pricing.* rounded to 6 decimals (matches checked-in shards)
 *
 * Modes:
 *   (default)     report  — print every provider's models + params (no writes)
 *   --json        emit the mapped catalog as JSON (machine-readable)
 *   --diff        report + per-provider added/removed id deltas (no writes)
 *   --merge       write: refresh known ids, keep ids no longer upstream
 *   --write       write: replace each shard with exactly what upstream serves
 *   --only=a,b    restrict to a comma-separated provider subset
 *   --source=X    openrouter (default) | modelsdev
 *
 * Run:
 *   node packages/ai/scripts/sync-models.mjs
 *   node packages/ai/scripts/sync-models.mjs --diff --only=deepseek
 *   npm run sync:models -w @duya/ai -- --write
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const providersDir = join(__dirname, '..', 'src', 'providers');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const MODELS_DEV_URL = 'https://models.dev/api.json';

const SHARD_HEADER = `// Model data. Sourced from https://openrouter.ai/api/v1/models (public,
// no key). OpenRouter is a no-auth model directory that proxies all the
// major Chinese vendors; we strip the upstream prefix and route through
// the provider's direct baseUrl. contextWindow / maxTokens / cost /
// modalities / reasoning flag all come from upstream metadata, which the
// direct endpoints honour identically.
`;

/**
 * Per-provider mapping. `prefix` is the OpenRouter vendor segment stripped
 * from every model id. `include` restricts to an explicit id list (used when
 * the direct endpoint serves only a subset); `idMap` renames an upstream id to
 * the vendor's native id. `write: false` marks hand-curated shards that must
 * not be regenerated wholesale.
 */
const PROVIDERS = {
  anthropic: { prefix: 'anthropic', api: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  deepseek: {
    prefix: 'deepseek',
    api: 'openai-chat',
    baseUrl: 'https://api.deepseek.com/v1',
    // Direct api.deepseek.com serves only these two ids; upstream carries the
    // V4.1 model names, the API exposes them as deepseek-flash / deepseek-v4-pro.
    include: ['deepseek-v4.1-flash', 'deepseek-v4-pro-0813'],
    idMap: {
      'deepseek-v4.1-flash': 'deepseek-flash',
      'deepseek-v4-pro-0813': 'deepseek-v4-pro',
    },
  },
  qwen: {
    prefix: 'qwen',
    api: 'openai-chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  kimi: { prefix: 'moonshotai', api: 'openai-chat', baseUrl: 'https://api.moonshot.ai/v1' },
  minimax: {
    prefix: 'minimax',
    api: 'anthropic',
    baseUrl: 'https://api.minimax.io/anthropic',
    write: false,
  },
  xai: { prefix: 'x-ai', api: 'openai-chat', baseUrl: 'https://api.x.ai/v1' },
  stepfun: { prefix: 'stepfun', api: 'openai-chat', baseUrl: 'https://api.stepfun.com/v1' },
  glm: { prefix: 'z-ai', api: 'openai-chat', baseUrl: 'https://api.z.ai/api/paas/v4', write: false },
  google: {
    prefix: 'google',
    api: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    write: false,
  },
  // Hand-curated shard: report only, never overwrite.
  openai: { prefix: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', write: false },
};

// models.dev groups providers under different slugs than our provider ids.
const MODELS_DEV_SLUG = {
  anthropic: 'anthropic',
  deepseek: 'deepseek',
  qwen: 'alibaba',
  kimi: 'moonshotai',
  minimax: 'minimax',
  xai: 'xai',
  stepfun: 'stepfun',
  glm: 'zai',
  google: 'google',
  openai: 'openai',
};

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);

const MODE = has('--write') ? 'write' : has('--merge') ? 'merge' : has('--diff') ? 'diff' : 'report';
const AS_JSON = has('--json');
const SOURCE = valueOf('--source') ?? 'openrouter';
const only = new Set(
  (valueOf('--only') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

const roundCost = (value) => Number(Number(value || 0).toFixed(6));
const bareId = (prefix, id) => (prefix ? id.slice(prefix.length + 1) : id);

function mapOpenRouter(slug, provider, entry) {
  const upstreamId = bareId(provider.prefix, entry.id);
  const inputModalities = entry.architecture?.input_modalities ?? [];
  const params = entry.supported_parameters ?? [];
  const ctx = entry.context_length ?? 0;
  const p = entry.pricing ?? {};
  return {
    id: provider.idMap?.[upstreamId] ?? upstreamId,
    name: entry.name || upstreamId,
    api: provider.api,
    providerId: slug,
    baseUrl: provider.baseUrl,
    reasoning: params.includes('reasoning'),
    input: inputModalities.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: ctx,
    maxTokens: entry.top_provider?.max_completion_tokens ?? entry.max_completion_tokens ?? ctx,
    cost: {
      input: roundCost(p.prompt),
      output: roundCost(p.completion),
      cacheRead: roundCost(p.input_cache_read),
      cacheWrite: roundCost(p.input_cache_write),
    },
  };
}

function mapModelsDev(slug, provider, modelId, m) {
  const inputModalities = m.modalities?.input ?? [];
  return {
    id: provider.idMap?.[modelId] ?? modelId,
    name: m.name || modelId,
    api: provider.api,
    providerId: slug,
    baseUrl: provider.baseUrl,
    reasoning: m.reasoning === true,
    input: inputModalities.includes('image') ? ['text', 'image'] : ['text'],
    contextWindow: m.limit?.context ?? 0,
    maxTokens: m.limit?.output ?? 0,
    cost: {
      input: roundCost(m.cost?.input),
      output: roundCost(m.cost?.output),
      cacheRead: roundCost(m.cost?.cache_read),
      cacheWrite: roundCost(m.cost?.cache_write),
    },
  };
}

/** Drop OpenRouter variant rows: ':batch' / ':free' suffixes and '~' aliases. */
function selectOpenRouter(provider, all) {
  const allow = provider.include ? new Set(provider.include) : null;
  return all.filter((m) => {
    if (provider.prefix && !m.id.startsWith(`${provider.prefix}/`)) return false;
    const tail = bareId(provider.prefix, m.id);
    if (tail.startsWith('~') || tail.includes(':')) return false;
    return !allow || allow.has(tail);
  });
}

function modelBlock(m) {
  return [
    '  {',
    `    id: '${m.id}',`,
    `    name: ${JSON.stringify(m.name)},`,
    `    api: '${m.api}',`,
    `    providerId: '${m.providerId}',`,
    `    baseUrl: '${m.baseUrl}',`,
    `    reasoning: ${m.reasoning},`,
    `    input: [${m.input.map((i) => `'${i}'`).join(', ')}],`,
    `    contextWindow: ${m.contextWindow},`,
    `    maxTokens: ${m.maxTokens},`,
    '    cost: {',
    `      input: ${m.cost.input},`,
    `      output: ${m.cost.output},`,
    `      cacheRead: ${m.cost.cacheRead},`,
    `      cacheWrite: ${m.cost.cacheWrite},`,
    '    },',
    '  },',
  ].join('\n');
}

function renderShard(slug, api, blocks) {
  return (
    `${SHARD_HEADER}import type { Model } from '../types.js';\n\n` +
    `export const ${slug}Models: Model<'${api}'>[] = [\n${blocks.join('\n')}\n];\n`
  );
}

function shardPath(slug) {
  return join(providersDir, `${slug}.models.ts`);
}

/** Parse a checked-in shard into its line ending + id -> raw model block text. */
function readShard(slug) {
  try {
    const src = readFileSync(shardPath(slug), 'utf8');
    const eol = src.includes('\r\n') ? '\r\n' : '\n';
    const blocks = new Map();
    for (const match of src.matchAll(/\r?\n(  \{\r?\n[\s\S]*?\r?\n  \},)/g)) {
      const id = match[1].match(/id: '([^']+)'/)?.[1];
      if (id) blocks.set(id, match[1].replace(/\r\n/g, '\n'));
    }
    return { eol, blocks };
  } catch {
    return { eol: '\n', blocks: new Map() };
  }
}

function fmtModel(m) {
  const flags = [m.reasoning ? 'reason' : 'plain', m.input.join('+')].join('/');
  return `${m.id.padEnd(34)} ctx=${String(m.contextWindow).padEnd(8)} out=${String(m.maxTokens).padEnd(
    7,
  )} ${flags.padEnd(16)} $${m.cost.input}/$${m.cost.output}`;
}

async function buildCatalog() {
  const slugs = Object.keys(PROVIDERS)
    .filter((slug) => only.size === 0 || only.has(slug))
    .sort();
  const catalog = {};

  if (SOURCE === 'modelsdev') {
    const res = await fetch(MODELS_DEV_URL);
    if (!res.ok) throw new Error(`models.dev returned HTTP ${res.status}`);
    const data = await res.json();
    for (const slug of slugs) {
      const provider = PROVIDERS[slug];
      const group = data[MODELS_DEV_SLUG[slug]];
      if (!group?.models) continue;
      const allow = provider.include ? new Set(provider.include) : null;
      catalog[slug] = Object.entries(group.models)
        .filter(([id, m]) => m.tool_call === true && (!allow || allow.has(id)))
        .map(([id, m]) => mapModelsDev(slug, provider, id, m))
        .sort((a, b) => a.id.localeCompare(b.id));
    }
    return catalog;
  }

  const res = await fetch(OPENROUTER_URL);
  if (!res.ok) throw new Error(`OpenRouter returned HTTP ${res.status}`);
  const data = (await res.json()).data;
  for (const slug of slugs) {
    const provider = PROVIDERS[slug];
    catalog[slug] = selectOpenRouter(provider, data)
      .map((m) => mapOpenRouter(slug, provider, m))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
  return catalog;
}

async function main() {
  const catalog = await buildCatalog();

  if (AS_JSON) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  let changes = 0;
  for (const slug of Object.keys(catalog).sort()) {
    const provider = PROVIDERS[slug];
    const models = catalog[slug];
    const { eol, blocks: checkedIn } = readShard(slug);
    const upstreamIds = new Set(models.map((m) => m.id));
    const added = models.filter((m) => !checkedIn.has(m.id)).map((m) => m.id);
    const removed = [...checkedIn.keys()].filter((id) => !upstreamIds.has(id));

    console.log(`\n== ${slug}  (${models.length} models from ${SOURCE})`);
    for (const m of models) {
      const mark = checkedIn.size === 0 || checkedIn.has(m.id) ? ' ' : '+';
      console.log(` ${mark} ${fmtModel(m)}`);
    }
    if (MODE !== 'report' && (added.length || removed.length)) {
      console.log(`   delta: +${added.length}${added.length ? ` [${added.join(', ')}]` : ''}`);
      console.log(`          -${removed.length}${removed.length ? ` [${removed.join(', ')}]` : ''}`);
    }

    if (MODE === 'report' || MODE === 'diff') {
      changes += added.length + removed.length;
      continue;
    }
    if (provider.write === false) {
      console.log(`   (${slug} is hand-curated — not written)`);
      continue;
    }

    let blocks;
    if (MODE === 'merge') {
      const merged = new Map(models.map((m) => [m.id, modelBlock(m)]));
      for (const [id, block] of checkedIn) if (!merged.has(id)) merged.set(id, block);
      blocks = [...merged.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, b]) => b);
    } else {
      blocks = models.map(modelBlock);
    }
    writeFileSync(shardPath(slug), eol === '\r\n' ? renderShard(slug, provider.api, blocks).replace(/\n/g, '\r\n') : renderShard(slug, provider.api, blocks));
    console.log(`   wrote src/providers/${slug}.models.ts (${blocks.length} models)`);
    changes += added.length + removed.length;
  }

  if (MODE !== 'report') console.log(`\n${changes} id-level change(s) detected.`);
}

main().catch((err) => {
  console.error(`sync-models failed: ${err.message}`);
  process.exitCode = 1;
});
