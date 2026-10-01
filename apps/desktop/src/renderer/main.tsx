import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/globals.css';

// Hide the anti-FOUC HTML splash as soon as React has mounted. The React
// `<StartupLanding>` overlay takes over for the longer "loading session"
// phase (DB hydration + initial message load). If React never mounts
// (e.g. an early script error), the splash stays visible so the user
// sees a branded error surface rather than a blank white window.
function hideBootSplash() {
  const el = document.getElementById('duya-boot-splash');
  if (!el) return;
  el.setAttribute('data-hidden', 'true');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App onReady={hideBootSplash} />
  </React.StrictMode>,
);
