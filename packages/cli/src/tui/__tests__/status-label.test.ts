import { describe, it, expect } from 'vitest';
import { resolveStatusLabel } from '../status-label.js';
import { TranscriptModel } from '../blocks.js';

/**
 * The two failures this locks:
 *
 * 1. A status frame appended a permanent notice row, so `Turn 1` and
 *    `@i18n:streaming.preparing` showed up as transcript CONTENT.
 * 2. The `@i18n:` prefix is a desktop convention, so the CLI printed the raw
 *    key because nothing resolved it.
 */
describe('status chrome never becomes transcript content', () => {
  it('drops a status frame instead of appending a notice row', () => {
    const model = new TranscriptModel();
    model.addUser('prompt');
    expect(model.apply({ type: 'status', data: { message: 'Turn 1' } })).toEqual({ kind: 'none' });
    expect(model.apply({ type: 'status', data: { message: '@i18n:streaming.preparing' } }))
      .toEqual({ kind: 'none' });
    expect(model.blocks.map((b) => b.kind)).toEqual(['user']);
  });

  it('resolves the desktop i18n keys the Host actually sends', () => {
    expect(resolveStatusLabel('@i18n:streaming.preparing')).toBe('Preparing response');
  });

  it('drops an unknown i18n key rather than printing its own name', () => {
    // The failure this prevents is a bare `@i18n:something.new` reaching the
    // screen. Showing nothing is recoverable; showing the key looks like a bug.
    expect(resolveStatusLabel('@i18n:streaming.brandNewKey')).toBeNull();
    expect(resolveStatusLabel('@i18n:')).toBeNull();
  });

  it('keeps a turn counter, which is chrome but worth showing', () => {
    expect(resolveStatusLabel('Turn 12')).toBe('Turn 12');
  });

  it('drops blank and whitespace-only messages', () => {
    expect(resolveStatusLabel('')).toBeNull();
    expect(resolveStatusLabel('   ')).toBeNull();
  });

  it('passes an ordinary status message through', () => {
    expect(resolveStatusLabel('compacting context')).toBe('compacting context');
  });
});
