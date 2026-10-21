import type {
  ModelCapabilityRecord,
  ModelCapabilityWriteInput,
} from '@duya/agent-protocol/model-capabilities';
import type { SqliteDatabase } from './sqlite-connection.js';

/** Persistence for the normalized model-capability cache in duya-main.db. */
export class ModelCapabilityStore {
  constructor(private readonly db: SqliteDatabase) {}

  get(modelName: string): ModelCapabilityRecord | null {
    const row = this.db.prepare('SELECT * FROM model_capabilities WHERE id = ?')
      .get(normalizeModelName(modelName)) as ModelCapabilityRecord | undefined;
    return row ?? null;
  }

  set(input: ModelCapabilityWriteInput): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO model_capabilities (id, is_multimodal, detected_at, detection_method) VALUES (?, ?, ?, ?)',
    ).run(
      normalizeModelName(input.modelName),
      input.isMultimodal ? 1 : 0,
      Date.now(),
      input.method || 'unknown',
    );
  }

  delete(modelName: string): boolean {
    const result = this.db.prepare('DELETE FROM model_capabilities WHERE id = ?')
      .run(normalizeModelName(modelName));
    return result.changes > 0;
  }
}

function normalizeModelName(modelName: string): string {
  return modelName.trim().toLowerCase();
}
