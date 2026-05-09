/**
 * Platform Hooks Types
 * Defines the interface for platform-specific browser handling
 */

import type { ICDPClient } from '../CDPClient.js';

export interface PlatformHooks {
  /** Platform name for logging */
  name: string;

  /** Called after navigation to handle platform-specific initialization */
  postNavigate?: (cdp: ICDPClient, url: string) => Promise<void>;

  /** Called before taking snapshot to ensure content is ready */
  preSnapshot?: (cdp: ICDPClient, url: string) => Promise<void>;

  /** Called after clicking an element to handle platform-specific responses */
  postClick?: (cdp: ICDPClient, url: string, selector: string) => Promise<void>;

  /** Called before scrolling to handle infinite scroll loading */
  preScroll?: (cdp: ICDPClient, url: string) => Promise<void>;
}
