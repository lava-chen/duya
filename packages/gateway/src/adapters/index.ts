/**
 * Adapters index - Self-registering adapter factories
 * Side-effect imports trigger registration
 */

// Import to register adapters (add new adapters here)
import './telegram.js';
import './feishu.js';
import './weixin.js';
import './qq.js';
import './discord.js';

export { PlatformAdapter, registerAdapterFactory, createAdapter, getRegisteredPlatforms } from './base.js';
export type { AdapterFactory } from './base.js';
