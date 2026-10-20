import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@duya/ui';
import '@duya/ui/styles.css';
import { configureUiServices } from '@/services';
import { createWebUiServices } from './client/ui-services-adapter.js';

const root = document.getElementById('root');
if (root === null) throw new Error('Web renderer root element is missing');

configureUiServices(createWebUiServices());
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
