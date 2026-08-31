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
      const result = parseAppDeclarationFile(readFileSync(join(MARKETPLACE, rel), 'utf-8'));
      if (!result.ok) {
        throw new Error(`${rel} rejected: ${result.reason}`);
      }
      expect(result.apps.length).toBeGreaterThan(0);
      // name-keyed form: the map key becomes the declaration's display name
      for (const app of result.apps) {
        expect(app.name).toBeTruthy();
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
