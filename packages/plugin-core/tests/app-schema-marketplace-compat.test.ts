// Plan 455 Phase B — acceptance check for the duya-marketplace repo's
// .app.json files. They use codex's name-keyed PluginAppFile shape
// (`{ apps: { <name>: { id } } }`); the parser normalizes them into
// reference declarations. Skips when the marketplace checkout is absent
// (external path, not part of this repo).

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseAppDeclarationFile } from '../src/connectors/app-schema.js';
import { isBuiltinConnectorId } from '../src/connectors/app-connector-id.js';

const MARKETPLACE = 'E:/Projects/duya-marketplace/duya-marketplace/plugins';

function marketplaceAppJsonFiles(): string[] {
  if (!existsSync(MARKETPLACE)) return [];
  return readdirSync(MARKETPLACE)
    .filter((name) => {
      const dir = join(MARKETPLACE, name);
      return statSync(dir).isDirectory() && existsSync(join(dir, '.app.json'));
    })
    .map((name) => join(name, '.app.json'));
}

const files = marketplaceAppJsonFiles();

describe('duya-marketplace .app.json acceptance', () => {
  it.skipIf(files.length === 0)('parses every marketplace plugin declaration', () => {
    for (const rel of files) {
      const raw = readFileSync(join(MARKETPLACE, rel), 'utf-8');
      const result = parseAppDeclarationFile(raw);
      if (!result.ok) {
        throw new Error(`${rel} rejected: ${result.reason}`);
      }
      expect(result.apps.length).toBeGreaterThan(0);
      for (const app of result.apps) {
        // `AppDeclarationFileSchema` accepts EITHER an array of declarations
        // OR codex's name-keyed `{ apps: { <name>: { id } } }` map. Only the
        // name-keyed form can supply a display name — the marketplace files
        // are the plain array form (`{ "apps": [{ "id": "github" }] }`), where
        // the connector's display name resolves from the builtin registry at
        // render time. So `name` is required only for the keyed form; `id` is
        // required for both, and the builtin-id contract is asserted by the
        // sibling test below.
        const apps = (JSON.parse(raw) as { apps?: unknown }).apps;
        const nameKeyed = apps !== null && !Array.isArray(apps);
        if (nameKeyed) {
          expect(app.name).toBeTruthy();
        }
        expect(app.id).toBeTruthy();
        expect(app.oauth).toBeUndefined();
        expect(app.tools).toEqual([]);
      }
    }
  });

  it.skipIf(files.length === 0)('every referenced id is a known builtin connector', () => {
    for (const rel of files) {
      const result = parseAppDeclarationFile(readFileSync(join(MARKETPLACE, rel), 'utf-8'));
      if (result.ok) {
        for (const app of result.apps) {
          expect(isBuiltinConnectorId(app.id), `${rel} -> ${app.id}`).toBe(true);
        }
      }
    }
  });
});
