// global.d.ts - Global type declarations

import type { ElectronAPI } from '../electron/preload';
import type React from 'react';

// Re-export ElectronAPI type for use in renderer code
export type { ElectronAPI } from '../electron/preload';

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        allowpopups?: boolean;
        partition?: string;
        src?: string;
      };
    }
  }
}
