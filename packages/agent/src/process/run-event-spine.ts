/**
 * Compatibility re-export. Run lifecycle assembly is owned by
 * `@duya/agent-runtime` (plan R1.1 moved it out of Host).
 */
export { createRunEventSpine } from '@duya/agent-runtime';
export type {
  RunEventSpine,
  RunEventSpineOptions,
  SpinePersistence,
} from '@duya/agent-runtime';
