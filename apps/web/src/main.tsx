import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@duya/ui';
import '@duya/ui/styles.css';
import { configureUiServices, configureWorkspaceLifecycle } from '@/services';
import { createWebUiServices, createWebWorkspaceLifecycle } from './client/ui-services-adapter.js';

const root = document.getElementById('root');
if (root === null) throw new Error('Web renderer root element is missing');

configureUiServices(createWebUiServices());
// The workspace-lifecycle port (plan 621). The shared panel reads the checkouts
// and the pull requests through it, so the Web installs its adapter next to
// the `UiServices` one — the browser reaches the Host through the same-origin
// BFF, and the BFF holds the Host bearer.
configureWorkspaceLifecycle(createWebWorkspaceLifecycle());
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
