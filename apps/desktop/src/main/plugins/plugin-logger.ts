import { getLogger } from '../logging/logger';
import type { PluginLogger } from '@duya/host/plugins/ports';

export function getPluginLogger(): PluginLogger {
  return {
    debug: (message, fields, component) => getLogger().debug(message, fields, component),
    info: (message, fields, component) => getLogger().info(message, fields, component),
    warn: (message, fields, component) => getLogger().warn(message, fields, component),
    error: (message, fields, component) => getLogger().error(message, undefined, fields, component),
  };
}
