/**
 * Adapters index - Self-registering adapter factories
 * Side-effect imports trigger registration
 */

// Import to register adapters (add new adapters here)
import './telegram/index.js';
import './qq/index.js';
import './whatsapp/index.js';
import './discord/index.js';
import './feishu/index.js';
import './weixin/index.js';

export { PlatformAdapter, registerAdapterFactory, createAdapter, getRegisteredPlatforms } from './base.js';
export type { AdapterFactory } from './base.js';
