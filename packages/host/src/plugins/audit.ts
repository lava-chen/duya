import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface PluginAuditEvent {
  kind: string;
  id: string;
  ts: number;
  invokedBy: 'cli';
  correlationId?: string | undefined;
  note: 'success' | 'failure';
}

/** Host records control-plane mutations; source paths and plugin declarations never enter audit. */
export function createPluginAudit(configRoot: string, warn: (message: string, fields: Record<string, unknown>) => void) {
  return async (event: PluginAuditEvent): Promise<void> => {
    try {
      await mkdir(configRoot, { recursive: true });
      await appendFile(path.join(configRoot, 'control-plane-audit.log.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 });
    } catch { warn('Could not append plugin audit event', { kind: event.kind, id: event.id }); }
  };
}
