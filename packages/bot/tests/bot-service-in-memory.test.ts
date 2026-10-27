/**
 * The Bot identity application service over in-memory ports (framework plan
 * S2 — moved verbatim from the Host's `bot-identity-service.test.ts`, where
 * it covered "the Desktop adapter shape"; only the journal swaps the Host fs
 * adapter for this package's InMemoryBotIdentityJournal, which is the same
 * bookkeeping without the bytes).
 */

import { describe, expect, it } from 'vitest';

import { createBotService, InMemoryBotIdentityJournal } from '../src/index.js';

describe('bot service — in-memory ports (the Desktop adapter shape)', () => {
  it('runs the same use cases over non-file ports', async () => {
    const agents: Record<string, Record<string, unknown>> = {};
    const service = createBotService({
      config: {
        async readAgents() {
          return agents as never;
        },
        async writeAgents(next) {
          Object.keys(agents).forEach((k) => delete agents[k]);
          Object.assign(agents, next);
        },
        async takenIds(keys) {
          return new Set(keys);
        },
      },
      profile: {
        async seedProfile() {
          return true;
        },
        async readProfile() {
          return null;
        },
      },
      journal: new InMemoryBotIdentityJournal(),
    });

    const created = await service.createBot({ name: 'Mem Bot' });
    const patched = await service.updateBot({ id: created.id, name: 'Renamed', expectedRevision: created.revision });
    expect(patched).toMatchObject({ id: created.id, name: 'Renamed', revision: 2 });
    expect(await service.getBot(created.id)).toMatchObject({ name: 'Renamed', revision: 2 });
  });
});
