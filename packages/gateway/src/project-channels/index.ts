/**
 * Project-channel transport factory (Gateway side).
 *
 * Consume this through the package subpath `@duya/gateway/project-channels`, not
 * through the package root: the root module is the forked gateway *process*
 * entry — importing it installs IPC listeners and posts `gateway:ready`. A Host
 * or CLI composition that only needs the neutral transport must not start a
 * second gateway process as an import side effect.
 */

export {
  ProjectDiscordTransport,
  createProjectDiscordTransport,
  type ProjectDiscordTransportOptions,
} from './transport.js';

export {
  ProjectChannelTransportFailure,
  isProjectChannelTransportFailure,
  type ProjectChannelTransportFailureParams,
} from './errors.js';

export {
  PROJECT_DISCORD_INTENTS,
  DEFAULT_RECONNECT_POLICY,
  type DiscordSocketLike,
  type ReconnectPolicy,
} from './socket.js';

export type { DiscordTimers } from './timers.js';
