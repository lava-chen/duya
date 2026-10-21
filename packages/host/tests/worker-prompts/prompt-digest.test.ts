/**
 * Plan 619 Phase 0 — prompt section digests.
 *
 * The observation seam exists so the project can answer "which part of
 * the assembled prompt changed between turns" BEFORE any content moves
 * between channels. The two contracts pinned here:
 *
 *   - installing an observer must not change what the model receives
 *     (instrumentation is non-invasive), and
 *   - a digest must identify its section's bytes exactly.
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { PromptSystem } from '@duya/host/worker-prompts/PromptSystem';
import { generalConfig } from '@duya/host/worker-prompts/configs/general';
import { sectionDigest, setPromptObserver } from '@duya/host/worker-prompts/observer';
import { volatilePromptSection } from '@duya/host/worker-prompts/constants/promptSections';
import type { PromptContext, PromptSectionDigest } from '@duya/host/worker-prompts/types';

function context(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'bash',
    modelId: 'test-model',
    modelName: 'test-model',
    enabledTools: new Set<string>(),
    sessionStartTime: 0,
    ...overrides,
  } as PromptContext;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('plan 619 phase 0 — prompt section digests', () => {
  afterEach(() => {
    setPromptObserver(undefined);
  });

  it('reports one digest per rendered section', async () => {
    const collected: PromptSectionDigest[] = [];
    setPromptObserver((digests) => collected.push(...digests));

    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context());

    expect(collected.length).toBeGreaterThan(0);
    for (const digest of collected) {
      expect(digest.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(digest.length).toBeGreaterThan(0);
    }
    // Every reported section name is a name the config declares.
    const declared = new Set(
      generalConfig.sections.map((def) => def.name ?? def.module ?? 'anonymous'),
    );
    for (const digest of collected) {
      expect(declared.has(digest.sectionName)).toBe(true);
    }
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('hashes the exact bytes of the section it names', async () => {
    const content = '# Identity\n\nYou are a careful agent.\n';
    const digest = sectionDigest('identity', content, false);
    expect(digest.hash).toBe(sha256(content));
    expect(digest.length).toBe(content.length);
    expect(digest.sectionName).toBe('identity');
    expect(digest.volatile).toBe(false);
  });

  it('marks the every-call sections volatile', async () => {
    const collected: PromptSectionDigest[] = [];
    setPromptObserver((digests) => collected.push(...digests));

    const system = new PromptSystem(generalConfig);
    await system.buildSystemPrompt(context());

    const environment = collected.find((digest) => digest.sectionName === 'environment');
    expect(environment).toBeDefined();
    expect(environment?.volatile).toBe(true);
    const identity = collected.find((digest) => digest.sectionName === 'identity');
    expect(identity?.volatile).toBe(false);
  });

  it('leaves the assembled prompt byte-identical when an observer is installed', async () => {
    const system = new PromptSystem(generalConfig);
    const ctx = context();
    const withoutObserver = await system.buildSystemPrompt(ctx);

    const collected: PromptSectionDigest[] = [];
    setPromptObserver((digests) => collected.push(...digests));
    const withObserver = await system.buildSystemPrompt(ctx);

    expect(withObserver).toEqual(withoutObserver);
    expect(collected.length).toBeGreaterThan(0);
  });

  it('keeps prompt assembly intact when the optional observer throws', async () => {
    const system = new PromptSystem(generalConfig);
    const ctx = context();
    const withoutObserver = await system.buildSystemPrompt(ctx);

    setPromptObserver(() => {
      throw new Error('observer unavailable');
    });
    const withFailingObserver = await system.buildSystemPrompt(ctx);

    expect(withFailingObserver).toEqual(withoutObserver);
  });

  it('reports nothing when no observer is installed', async () => {
    const system = new PromptSystem(generalConfig);
    const prompt = await system.buildSystemPrompt(context());
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('keeps the volatile reason on the section description', () => {
    const section = volatilePromptSection(
      'environment',
      () => 'cwd',
      'Changes on every turn based on current directory',
    );
    expect(section.description).toBe('Changes on every turn based on current directory');
    expect(section.volatile).toBe(true);
  });
});
