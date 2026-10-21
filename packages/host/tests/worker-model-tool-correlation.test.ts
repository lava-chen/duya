import { describe, expect, it } from 'vitest';
import { fromProviderMessages, toProviderMessages } from '../src/run-engine-model.js';
import { toModelMessages } from '../src/worker-run-composition.js';
import type { Message } from '../src/worker-run-contracts.js';

describe('worker tool-result correlation at the model boundary', () => {
  it('preserves the call identity from product history through the engine into provider messages', () => {
    const history: Message[] = [{
      id: 'result-row', role: 'tool', tool_call_id: 'provider-call-1', content: 'result-from-executor',
    }];
    expect(toProviderMessages(toModelMessages(history))).toEqual(history);
    expect(toProviderMessages(fromProviderMessages(history))).toEqual(history);
  });
});
