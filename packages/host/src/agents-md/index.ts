/**
 * packages/host/src/agents-md/index.ts
 *
 * The `/init` write, shared by every surface that can perform it.
 *
 * The desktop writes through IPC and the CLI writes through the Host, but the
 * part that decides WHAT to write and WHERE is the same on both: the template,
 * the marker, the repository root, and the idempotent write. Keeping that
 * here is what makes the two surfaces write the same file.
 */

export {
  buildInitAgentsMdTemplate,
  initAgentsMdMarker,
  INIT_AGENTS_MD_MARKER_PREFIX,
  INIT_AGENTS_MD_MARKER_REGEX,
  INIT_AGENTS_MD_VERSION,
  readInitAgentsMdVersion,
  type InitAgentsMdInput,
} from './init-template.js';

export { resolveAgentsMdRoot } from './root.js';

export { AGENTS_MD_FILENAME, writeInitAgentsMd } from './write-agents-md.js';
