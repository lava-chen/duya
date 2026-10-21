import { randomUUID } from 'node:crypto';
import type {
  ManageRoutinePort,
  RoutineCreateInput,
  RoutineRecord,
  RoutineUpdateInput,
} from '@duya/capabilities/ManageRoutineTool/ports';
import { automationDb, messageDb } from '../worker-db-client.js';

/** Bind bot-owned routine operations to the Host DB bridge and transcript. */
export function createWorkerManageRoutinePort(): ManageRoutinePort {
  return {
    resolveSessionId(context) {
      const options =
        context && typeof context === 'object'
          ? (context as { options?: unknown }).options
          : undefined;
      const sessionId =
        options && typeof options === 'object'
          ? (options as Record<string, unknown>).sessionId
          : undefined;
      return (typeof sessionId === 'string' && sessionId) || process.env.SESSION_ID || '';
    },
    async listRoutines() {
      return (await automationDb.listCrons()) as RoutineRecord[];
    },
    async createRoutine(input: RoutineCreateInput) {
      return (await automationDb.createCron(input)) as RoutineRecord;
    },
    async updateRoutine(id: string, input: RoutineUpdateInput) {
      return (await automationDb.updateCron(id, input)) as RoutineRecord;
    },
    async deleteRoutine(id: string) {
      await automationDb.deleteCron(id);
    },
    async appendRoutineMarker(sessionId, action, routineId, name) {
      await messageDb.append(sessionId, [
        {
          id: `routine-marker-${randomUUID()}`,
          role: 'assistant',
          content: `${action} routine "${name}"`,
          status: 'complete',
          msg_type: 'text',
          source: 'routine_activity',
          timestamp: Date.now(),
          metadata: {
            source: 'routine_activity',
            routine: {
              action,
              name,
              ...(routineId ? { routineId } : {}),
            },
          },
        },
      ]);
    },
  };
}
