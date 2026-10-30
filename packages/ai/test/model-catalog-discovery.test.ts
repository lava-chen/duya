/**
 * Model catalog discovery vs. admission.
 *
 * The nightly refresh must scan each shard's FULL upstream catalogue and
 * report what it found, while only writing new ids that pass the admission
 * rules. These tests run the real script against a local fixture directory:
 * no network, and writes go to a copied shard tree.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../scripts/sync-models.mjs', import.meta.url));
const openaiShard = fileURLToPath(new URL('../src/providers/openai.models.ts', import.meta.url));
const openrouterShard = fileURLToPath(
  new URL('../src/providers/openrouter.models.ts', import.meta.url),
);

const workDir = mkdtempSync(join(tmpdir(), 'duya-model-discovery-'));
const fixtureDir = join(workDir, 'fixtures');
const providersDir = join(workDir, 'providers');
const reportOpenai = join(workDir, 'report-openai.md');
const reportOpenrouter = join(workDir, 'report-openrouter.md');

const TODAY = '2026-10-29';

/** Minimal models.dev entry that `mapModelsDev` can consume. */
function modelsDevEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    family: 'gpt',
    reasoning: false,
    tool_call: true,
    release_date: '2026-10-20',
    limit: { context: 128000, output: 8192 },
    modalities: { input: ['text'], output: ['text'] },
    cost: { input: 1, output: 2 },
    ...overrides,
  };
}

/** Ids currently checked in to the OpenAI shard. */
function checkedInOpenAiIds(): string[] {
  return [...readFileSync(openaiShard, 'utf8').matchAll(/id: '([^']+)'/g)].map(
    (match) => match[1],
  );
}

function writeFixtures() {
  mkdirSync(fixtureDir, { recursive: true });

  const openaiModels: Record<string, unknown> = {};
  // Everything the shard already lists: retained regardless of its age.
  for (const id of checkedInOpenAiIds()) {
    openaiModels[id] = modelsDevEntry(id, { release_date: '2024-01-01' });
  }

  // New, recent, tool-capable, text-in/text-out: admitted.
  openaiModels['gpt-6.1-terra'] = modelsDevEntry('gpt-6.1-terra', {
    release_date: '2026-10-26',
  });
  // New and recent but not tool-capable: held.
  openaiModels['gpt-6.1-nofunc'] = modelsDevEntry('gpt-6.1-nofunc', {
    tool_call: false,
  });
  // New and recent but emits images: held.
  openaiModels['gpt-6.1-image'] = modelsDevEntry('gpt-6.1-image', {
    modalities: { input: ['text'], output: ['image', 'text'] },
  });
  // Retired upstream (models.dev keeps it listed with status). Held.
  openaiModels['gpt-5.0-retired'] = modelsDevEntry('gpt-5.0-retired', {
    release_date: '2026-10-20',
    status: 'deprecated',
  });
  // Same group, outside the 45-day window: listed under older discoveries,
  // never auto-admitted.
  openaiModels['gpt-5.0-old'] = modelsDevEntry('gpt-5.0-old', {
    release_date: '2023-10-01',
  });

  writeFileSync(
    join(fixtureDir, 'modelsdev.json'),
    JSON.stringify({ openai: { models: openaiModels } }, null, 2),
  );

  writeFileSync(
    join(fixtureDir, 'openrouter.json'),
    JSON.stringify(
      {
        data: [
          {
            id: 'openai/gpt-6.1-terra',
            name: 'GPT-6.1 Terra',
            created: Math.floor(Date.parse('2026-10-26T00:00:00Z') / 1000),
            context_length: 128000,
            top_provider: { max_completion_tokens: 8192 },
            pricing: { prompt: 0.000001, completion: 0.000002 },
            supported_parameters: ['tools'],
            architecture: {
              input_modalities: ['text'],
              output_modalities: ['text'],
            },
          },
        ],
      },
      null,
      2,
    ),
  );

  // A copy of the shards the write-mode tests may rewrite.
  mkdirSync(providersDir, { recursive: true });
  writeFileSync(join(providersDir, 'openai.models.ts'), readFileSync(openaiShard));
  writeFileSync(join(providersDir, 'openrouter.models.ts'), readFileSync(openrouterShard));
}

function runSync(
  shard: string,
  reportPath: string,
  extraFlags: string[] = [],
  extraEnv: Record<string, string> = {},
): string {
  execFileSync(
    process.execPath,
    [scriptPath, `--only=${shard}`, `--report=${reportPath}`, ...extraFlags],
    {
      env: {
        ...process.env,
        SYNC_MODELS_FIXTURE_DIR: fixtureDir,
        SYNC_MODELS_PROVIDERS_DIR: providersDir,
        SYNC_MODELS_TODAY: TODAY,
        SYNC_MODELS_RECENT_DAYS: '45',
        ...extraEnv,
      },
      encoding: 'utf8',
    },
  );
  return readFileSync(reportPath, 'utf8');
}

/** Pull one `<details>` block out of the Markdown report by its summary. */
function detailsBlock(report: string, summaryPrefix: string): string {
  return report.match(new RegExp(`${summaryPrefix}（\\d+）[\\s\\S]*?<\\/details>`))?.[0] ?? '';
}

describe('model catalog discovery', () => {
  writeFixtures();
  const openaiBefore = readFileSync(openaiShard, 'utf8');
  const openrouterBefore = readFileSync(openrouterShard, 'utf8');

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('admits a recent tool-capable text model and reports held candidates', () => {
    const report = runSync('openai', reportOpenai);

    const admitted = detailsBlock(report, '自动收录');
    expect(admitted, '近期纯文本新模型应进入自动收录').toContain('gpt-6.1-terra');
    expect(admitted, '自动收录应带发布日期').toContain('2026-10-26');
    expect(admitted, '更早的模型不应自动收录').not.toContain('gpt-5.0-old');

    const recent = detailsBlock(report, '近期未收录');
    expect(recent, '非 tool_call 的近期模型应列出并说明原因').toContain('gpt-6.1-nofunc');
    expect(recent).toContain('no_tool_call');
    expect(recent, '输出含图片的近期模型应列出并说明原因').toContain('gpt-6.1-image');
    expect(recent).toContain('non_chat_output');
    expect(recent, '上游标记 deprecated 的模型不应被自动上架').toContain('gpt-5.0-retired');
    expect(recent).toContain('deprecated_upstream');

    const older = detailsBlock(report, '更早未收录');
    expect(older, '窗口外的候选仍要列出，避免漏掉补录的上游条目').toContain('gpt-5.0-old');
  });

  it('does not write the checked-in shard in discovery mode', () => {
    runSync('openai', reportOpenai, ['--discover']);
    expect(readFileSync(openaiShard, 'utf8')).toBe(openaiBefore);
    expect(readFileSync(join(providersDir, 'openai.models.ts'), 'utf8')).toBe(openaiBefore);
  });

  it('writes only admitted ids and keeps checked-in models', () => {
    const written = join(providersDir, 'openai.models.ts');
    runSync('openai', reportOpenai, ['--write']);

    const text = readFileSync(written, 'utf8');
    expect(text, '准入的新模型应写入').toContain("id: 'gpt-6.1-terra'");
    expect(text, '已签入模型应保留').toContain("id: 'gpt-4.1'");
    expect(text, '未准入的近期模型不应写入').not.toContain('gpt-6.1-nofunc');
    expect(text, '非纯文本模型不应写入').not.toContain("id: 'gpt-6.1-image'");
    expect(text, 'deprecated 模型不应写入').not.toContain('gpt-5.0-retired');
    expect(text, '窗口外模型不应写入').not.toContain('gpt-5.0-old');
  });

  it('reports new OpenRouter ids without writing them', () => {
    const report = runSync('openrouter', reportOpenrouter, ['--discover']);

    const recent = detailsBlock(report, '近期未收录');
    expect(recent).toContain('openai/gpt-6.1-terra');
    expect(recent, 'OpenRouter shard 应说明只维护离线种子').toContain('auto_add_disabled');
    expect(recent).toContain('只维护离线种子');

    const admitted = detailsBlock(report, '自动收录');
    expect(admitted, 'OpenRouter 不应自动收录新模型').not.toContain('openai/gpt-6.1-terra');
    expect(readFileSync(openrouterShard, 'utf8')).toBe(openrouterBefore);
    expect(readFileSync(join(providersDir, 'openrouter.models.ts'), 'utf8')).toBe(
      openrouterBefore,
    );
  });
});
