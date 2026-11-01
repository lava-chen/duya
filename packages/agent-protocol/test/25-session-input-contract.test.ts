/**
 * Drift test #25 — the R1.0 structured-input contract.
 *
 * ## What is being guarded
 *
 * R1.0 audited the three input paths the product actually has (a user chat
 * turn, a TUI steer through the mailbox, a Bot dispatch through the inbox)
 * and found that none of them can answer "was this accepted, and where is it
 * now?". `session-input.ts` introduces the vocabulary that will: a receipt
 * with five provable stages, and a per-session control lease with a revision
 * the holder has to present.
 *
 * The five stages are the load-bearing part. They are the plan's P2 contract,
 * and each one has to correspond to a durable fact the Host can point at. A
 * sixth stage — `accepted`, say, which is the obvious thing to add — would be
 * a stage that cannot be proven, and a stage that cannot be proven is a stage
 * the Host would have to guess at. So the set is asserted exactly, not
 * "contains at least".
 *
 * The second assertion is a regression guard for a real defect the audit
 * found: `HostRunExecutionApiV1` declared `watchLiveAgentRunEvents` TWICE
 * (`run-api.ts:356` and `:365`). TypeScript accepts duplicate members with
 * compatible signatures, so it compiled, and R1.1 was about to compose a
 * narrow call surface out of this interface — where a duplicated member makes
 * the composed result depend on how the composition is written. The interface
 * now declares it once, and this test fails if a second declaration comes
 * back.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SESSION_CONTROL_HOLDER_KINDS,
  SESSION_INPUT_ACTOR_KINDS,
  SESSION_INPUT_INTENTS,
  SESSION_INPUT_STAGES,
} from '../src/index.js';

const RUN_API_SRC = fileURLToPath(new URL('../src/run-api.ts', import.meta.url));
const SESSION_INPUT_SRC = fileURLToPath(new URL('../src/session-input.ts', import.meta.url));

describe('drift #25: the R1.0 session input contract', () => {
  it('the receipt stages are exactly the five provable ones', () => {
    expect([...SESSION_INPUT_STAGES]).toEqual([
      'persisted',
      'queued',
      'delivered',
      'consumed',
      'rejected',
    ]);
  });

  it('no stage is listed twice', () => {
    expect(new Set(SESSION_INPUT_STAGES).size).toBe(SESSION_INPUT_STAGES.length);
    expect(new Set(SESSION_INPUT_INTENTS).size).toBe(SESSION_INPUT_INTENTS.length);
    expect(new Set(SESSION_INPUT_ACTOR_KINDS).size).toBe(SESSION_INPUT_ACTOR_KINDS.length);
    expect(new Set(SESSION_CONTROL_HOLDER_KINDS).size).toBe(SESSION_CONTROL_HOLDER_KINDS.length);
  });

  it('the intents cover steer, enqueue and interrupt — and nothing else', () => {
    // An intent the Host cannot honour must be refused, not silently
    // downgraded: a caller that asked to steer and got a queued turn has been
    // told a falsehood.
    expect([...SESSION_INPUT_INTENTS]).toEqual(['steer', 'enqueue', 'interrupt']);
  });

  it('the actor kinds include the ones the product already has callers for', () => {
    expect([...SESSION_INPUT_ACTOR_KINDS]).toEqual([
      'user',
      'bot',
      'plugin',
      'channel',
      'system',
    ]);
  });

  it('a control lease can be held by a user, a bot or a plugin', () => {
    expect([...SESSION_CONTROL_HOLDER_KINDS]).toEqual(['user', 'bot', 'plugin']);
  });

  it('HostRunExecutionApiV1 declares watchLiveAgentRunEvents exactly once', () => {
    const source = readFileSync(RUN_API_SRC, 'utf8');
    const declarations = source.match(/watchLiveAgentRunEvents\?\(/g) ?? [];
    expect(declarations.length).toBe(1);
  });

  it('session-input.ts imports nothing but the attachment type', () => {
    // The package is a transport-neutral leaf (drift #1). A new file that
    // pulled in storage or transport would break that for every consumer.
    const source = readFileSync(SESSION_INPUT_SRC, 'utf8');
    const imports = [...source.matchAll(/^import\s[^;]*from\s'([^']+)';/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./file-attachment.js']);
  });
});
