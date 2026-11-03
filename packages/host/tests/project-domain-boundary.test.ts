import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Project Coordinator runs on the shared Session runtime. Its product
 * identity and Task rules belong behind the `projectDispatch` port; generic
 * Session management must not learn them again through string literals.
 */
const sessionService = readFileSync(
  new URL('../src/session-service.ts', import.meta.url),
  'utf8',
);

describe('project domain boundary', () => {
  it('keeps Coordinator product identity out of generic Session management', () => {
    expect(sessionService).not.toContain('project-coordinator');
    expect(sessionService).not.toContain('code-expert');
    expect(sessionService).not.toContain('projectCoordination');
  });
});
