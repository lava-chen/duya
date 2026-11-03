/**
 * The mock entry point.
 *
 * ## What this is
 *
 * A browser-only build of the REAL renderer, wired to a fake Host. The
 * components, the styles and the plumbing are the product's; only the data
 * is fake. That is what makes it useful for a structural change: a sidebar
 * that moved, a panel that docked at the bottom, a column that got wider —
 * all of them are the real components, so the result is what the product
 * would look like, not a picture of it.
 *
 * ## How to run it
 *
 *     npm run mock:ui
 *     # then open http://127.0.0.1:3001/packages/ui/src/mock/index.html
 *
 * ## URL parameters
 *
 * - `?shell=<id>` — the structural variant (see `variants/index.ts`).
 * - `?session=<id>` — which mock session opens first.
 *
 * ## What is faked, and where
 *
 * - The HOST: `createMockHostBridge()` answers sessions, runs, approvals and
 *   the provider roster from memory. It is composed by the SHARED factory
 *   (`createUiServices`), so the plumbing under the renderer is the product's.
 * - The TRANSCRIPT: the sidebar's session list and the user's own turns come
 *   from the conversation store, which the product normally fills over
 *   Electron IPC. The mock seeds the store directly instead, because the
 *   browser has no IPC.
 */

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { configureUiServices, createUiServices } from '@/services';
import { useConversationStore } from '@/stores/conversation-store';
import { createMockHostBridge } from './mock-host-bridge';
import { MOCK_PROJECT_GROUPS, MOCK_SESSION_IDS, MOCK_THREADS, MOCK_USER_MESSAGES } from './fixtures';
import { applyShellVariant, resolveShellVariant, SHELL_VARIANTS } from './variants';
import { SchematicView } from './variants/schematic';
import '@duya/ui/styles.css';
import './variants/variants.css';

const search = window.location.search;
const variant = resolveShellVariant(search);
const sessionParam = new URLSearchParams(search).get('session');
const initialSession = sessionParam !== null && MOCK_THREADS.some((thread) => thread.id === sessionParam)
  ? sessionParam
  : MOCK_SESSION_IDS.sidebar;

const mockBridge = createMockHostBridge();

configureUiServices(
  createUiServices({
    bridge: mockBridge,
    // The web platform keeps the renderer off every Electron-only path, so
    // the mock runs the same code a browser can run.
    platform: 'web',
    capabilities: {
      localFileAccess: false,
      settings: false,
      extensions: false,
      bots: false,
      automation: false,
      workflows: false,
      // The turn's configuration still travels, so the composer offers the
      // permission-mode and model controls the product shows.
      turnConfiguration: true,
    },
  }),
);

/**
 * Seed the conversation store.
 *
 * The product fills this from the Electron DB bridge. The browser has no
 * such bridge, so the mock writes the same state directly — the shape is the
 * store's own, so the sidebar renders the same rows it would in the product.
 */
function seedConversation(): void {
  useConversationStore.setState({
    threads: [...MOCK_THREADS],
    messages: { ...MOCK_USER_MESSAGES },
    projects: [...MOCK_PROJECT_GROUPS],
    activeThreadId: initialSession,
    currentView: 'chat',
    isHydrated: true,
  });
}

seedConversation();

// The onboarding flow is a first-run modal. The mock is not a first run.
try {
  window.localStorage.setItem('duya-onboarding-completed', '1');
} catch {
  // A browser that refuses storage still runs the mock.
}

/**
 * Quiet the legacy Agent-Server warning.
 *
 * The chat view still polls the OLD Electron-only Agent Server for a session
 * status, and logs a warning every poll because the mock has no such server.
 * The mock answers through the Host run projection instead, so the warning
 * carries no information here — but it drowns everything else in the console
 * while a layout is being worked on.
 *
 * Only THIS message is filtered. Every other warning and every error still
 * reaches the console.
 */
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  const first = args[0];
  if (typeof first === 'string' && first.startsWith('[agent-http-client]')) return;
  originalWarn(...args);
};

applyShellVariant(variant);

/** A small switcher so two structures can be compared without editing URLs. */
function VariantSwitcher() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'F2') return;
      const index = SHELL_VARIANTS.findIndex((candidate) => candidate.id === variant.id);
      const next = SHELL_VARIANTS[(index + 1) % SHELL_VARIANTS.length]!;
      const url = new URL(window.location.href);
      url.searchParams.set('shell', next.id);
      window.location.href = url.toString();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <nav className="mock-switcher" aria-label="结构变体">
      {SHELL_VARIANTS.map((candidate) => (
        <a
          key={candidate.id}
          className="mock-switcher-item"
          data-active={candidate.id === variant.id ? 'true' : undefined}
          href={`?shell=${candidate.id}`}
          title={candidate.description}
        >
          {candidate.label}
        </a>
      ))}
    </nav>
  );
}

const container = document.getElementById('root');
if (container === null) throw new Error('Mock root element is missing');

createRoot(container).render(
  <StrictMode>
    {variant.schematic ? <SchematicView /> : <App />}
    <VariantSwitcher />
  </StrictMode>,
);
