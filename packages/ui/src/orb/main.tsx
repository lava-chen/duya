/**
 * Orb — Wake Agent UI entry.
 *
 * 独立 React bundle,与主窗口共享 electron preload API(window.electronAPI.orb),
 * 通过 IPC channel `automation:orb:*` 与 main process 通信。
 *
 * 主题跟随主窗口:由 main process 在 onThemeChanged 时设置 document.documentElement.dataset.theme。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OrbApp } from './OrbApp';
// Full app token set (:root/[data-theme] vars, Tailwind). orb.css loads
// after and neutralizes document-level styles (transparent body).
import '../styles/globals.css';
import './orb.css';

const root = document.getElementById('orb-root');
if (!root) throw new Error('orb-root element missing');

createRoot(root).render(
  <StrictMode>
    <OrbApp />
  </StrictMode>,
);