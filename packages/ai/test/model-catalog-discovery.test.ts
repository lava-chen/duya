/**
 * Model catalog discovery vs. admission.
 *
 * The nightly refresh must scan each shard's FULL upstream catalogue and
 * report what it found, while only writing new ids that pass the admission
 * rules. These tests run the real script against a local fixture directory:
 * no network, no writes to the checked-in shards.
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

function writeFixtures() {
  mkdirSync(fixtureDir, { recursive: true });

  const openaiModels: Record<string, unknown> = {
    // Already checked in: retained regardless of its 2024 release date.
    'gpt-4.1': modelsDevEntry('gpt-4.1', { release_date: '2024-04-01' }),
    // New, recent, tool-capable, text-in/text-out: admitted.
    'gpt-6.1-terra': modelsDevEntry('gpt-6.1-terra', { release_date: '2026-10-26' }),
    // New and recent but not tool-capable: held.
    'gpt-6.1-nofunc': modelsDevEntry('gpt-6.1-nofunc', { tool_call: false }),
    // New and recent but emits images: held.
    'gpt-6.1-image': modelsDevEntry('gpt-6.1-image', {
      modalities: { input: ['text'], output: ['image', 'text'] },
    }),
    // Same group, outside the 45-day window: only counted, never listed.
    'gpt-5.0-old': modelsDevEntry('gpt-5.0-old', { release_date: '2023-10-01' }),
  };

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
}

function runSync(shard: string, reportPath: string, extraFlags: string[] = []): string {
  execFileSync(process.execPath, [scriptPath, `--only=${shard}`, `--report=${reportPath}`, ...extraFlags], {
    env: {
      ...process.env,
      SYNC_MODELS_FIXTURE_DIR: fixtureDir,
      SYNC_MODELS_TODAY: TODAY,
      SYNC_MODELS_RECENT_DAYS: '45',
    },
    encoding: 'utf8',
  });
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

    const held = detailsBlock(report, '发现但未收录');
    expect(held, '非 tool_call 的近期模型应列出并说明原因').toContain('gpt-6.1-nofunc');
    expect(held).toContain('no_tool_call');
    expect(held, '输出含图片的近期模型应列出并说明原因').toContain('gpt-6.1-image');
    expect(held).toContain('non_chat_output');

    // The 2023 model is outside the window: counted, never listed or admitted.
    expect(report).not.toContain('gpt-5.0-old');
    expect(report).toContain('另有 1 个更早的未收录模型');
  });

  it('does not write the checked-in shard in discovery mode', () => {
    // Run again to make sure the report-only mode is idempotent.
    runSync('openai', reportOpenai, ['--discover']);
    expect(readFileSync(openaiShard, 'utf8')).toBe(openaiBefore);
  });

  it('reports new OpenRouter ids without writing them', () => {
    const report = runSync('openrouter', reportOpenrouter, ['--discover']);

    const held = detailsBlock(report, '发现但未收录');
    expect(held).toContain('openai/gpt-6.1-terra');
    expect(held, 'OpenRouter shard 应说明只维护离线种子').toContain('auto_add_disabled');
    expect(held).toContain('只维护离线种子');

    const admitted = detailsBlock(report, '自动收录');
    expect(admitted, 'OpenRouter 不应自动收录新模型').not.toContain('openai/gpt-6.1-terra');
    expect(readFileSync(openrouterShard, 'utf8')).toBe(openrouterBefore);
  });
});
