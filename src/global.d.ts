// global.d.ts - Global type declarations

import type { ElectronAPI } from '../electron/preload';

// Re-export ElectronAPI type for use in renderer code
export type { ElectronAPI } from '../electron/preload';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
