import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('architecture CI wiring', () => {
  it('runs the graph parity, retirement ratchet, and baseline shrink gates', () => {
    const workflow = parse(readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8'));
    const steps = workflow.jobs.architecture.steps.map((step: { run?: string }) => step.run ?? '');
    const commands = steps.join('\n');

    expect(commands).toContain('npm run architecture:slice-graph');
    expect(commands).toContain('npm run agent-retirement-gate');
    expect(commands).toContain('npm run architecture:baseline-ratchet');
  });
});
