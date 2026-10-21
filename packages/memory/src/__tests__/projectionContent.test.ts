import { describe, it, expect } from 'vitest';
import {
  deriveRolloutSummaryFilename,
  rolloutShortId,
  sanitizeRolloutSlug,
} from '../projectionContent';

/**
 * Filename sanitization (Plan 304 Phase C, design v3 D11).
 *
 * Rollout ids may contain characters that are illegal in Windows
 * filenames — cron session ids are shaped `cron:<uuid>:<ts>:<uuid>`,
 * whose `:` would otherwise leak into the derived summary filename and
 * fail the outbox write with EINVAL. This guards the filename grammar.
 */

describe('rolloutShortId', () => {
  it('keeps the first 8 hex chars for a plain uuid', () => {
    expect(rolloutShortId('4fbe376d-ef71-47d8-9061-fd67a5272403')).toBe('4fbe376d');
  });

  it('strips the colon prefix from a cron session id', () => {
    expect(
      rolloutShortId('cron:4fbe376d-ef71-47d8-9061-fd67a5272403:1786373100013:56a71aca-bcab-4260-aab4-23806178b889'),
    ).toBe('4fbe376d');
  });

  it('lowercases and truncates to 8 hex chars', () => {
    expect(rolloutShortId('ABCDEF0123456789')).toBe('abcdef01');
  });
});

describe('deriveRolloutSummaryFilename', () => {
  it('produces a Windows-safe filename for a cron rollout', () => {
    const filename = deriveRolloutSummaryFilename({
      rollout_id: 'cron:4fbe376d-ef71-47d8-9061-fd67a5272403:1786373100013:56a71aca-bcab-4260-aab4-23806178b889',
      rollout_slug: 'memory-items',
      generated_at: 1_700_000_000_000,
    });
    expect(filename).not.toContain(':');
    expect(filename).toBe('2023-11-14T22-13-20-4fbe376d-memory-items.md');
  });

  it('keeps the existing shape for a plain uuid rollout', () => {
    const filename = deriveRolloutSummaryFilename({
      rollout_id: '4fbe376d-ef71-47d8-9061-fd67a5272403',
      rollout_slug: 'extract-invoice-data',
      generated_at: 1_700_000_000_000,
    });
    expect(filename).toBe('2023-11-14T22-13-20-4fbe376d-extract-invoice-data.md');
  });
});

describe('sanitizeRolloutSlug', () => {
  it('replaces illegal filename characters with dashes and keeps ascii alnum', () => {
    expect(sanitizeRolloutSlug('提取发票PDF数据')).toBe('----pdf--');
  });
});