/**
 * Adapter side-effect imports.
 *
 * Each module registers itself with `registerAdapterFactory()` on import, so
 * this file is the single place that decides which channels exist. Order is
 * irrelevant; adding a channel means adding one line here plus its descriptor
 * in `platform-capabilities.ts`.
 */

import './feishu/index.js';
import './telegram/index.js';
import './weixin/index.js';
import './discord/index.js';
import './qq/index.js';
import './whatsapp/index.js';
import './whatsapp-cloud/index.js';
import './signal/index.js';
import './bluebubbles/index.js';
import './webhook/index.js';
import './msgraph/index.js';
