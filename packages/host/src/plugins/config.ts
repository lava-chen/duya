import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parse, stringify } from '@iarna/toml';
import { editConfigNamespace, verifyConfigNamespace } from '../config-agents/config-file.js';
import type { PluginConfigPort } from './ports.js';

/** A namespace port over the shared TOML document, always read before editing. */
export function createPluginConfig(configRoot: string): PluginConfigPort {
  const file = path.join(configRoot, 'config.toml');
  function read(): { text: string; document: Record<string, unknown> } {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      text = '';
    }
    return { text, document: parse(text) as Record<string, unknown> };
  }
  return {
    getByPath(key) { return read().document[key]; },
    set(key, value) {
      if (key !== 'plugins' && key !== 'marketplaces') throw new Error('Invalid plugin configuration namespace');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin configuration must be a table');
      const { text, document } = read();
      const table = value as Record<string, unknown>;
      let next = editConfigNamespace(text, key, table);
      if (next === null || !verifyConfigNamespace(next, key, table)) next = stringify({ ...document, [key]: table } as Parameters<typeof stringify>[0]);
      fs.mkdirSync(configRoot, { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, next, { mode: 0o600 });
        fs.renameSync(temporary, file);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return true;
    },
  };
}
