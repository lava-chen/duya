import { describe, it, expect } from 'vitest';
import { snapshotAction } from '../actions/snapshot.js';

describe('snapshot action defaults', () => {
  it('defaults to interactive-only with a 50k cap', () => {
    const parsed = snapshotAction.schema.parse({});
    expect(parsed).toEqual({ maxLength: 50000, interactiveOnly: true });
  });

  it('still accepts explicit overrides including string forms', () => {
    expect(
      snapshotAction.schema.parse({ interactiveOnly: 'false', maxLength: '123456' }),
    ).toEqual({ maxLength: 123456, interactiveOnly: false });
    expect(snapshotAction.schema.parse({ interactiveOnly: true })).toEqual({
      maxLength: 50000,
      interactiveOnly: true,
    });
  });
});
