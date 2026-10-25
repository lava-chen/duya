import React from "react";
import ReactDOM from "react-dom/client";
import { App, DetachedPanelRoot } from "@duya/ui";
import { configureWorkspaceLifecycle } from "@duya/ui/services";
import { createElectronWorkspaceLifecyclePort } from "@duya/ui/lib/workspace-lifecycle-ipc";
import "@duya/ui/styles.css";

function hideBootSplash() {
  document.getElementById("duya-boot-splash")?.setAttribute("data-hidden", "true");
}

// Plan 621 slice F: install the Desktop's adapter for the workspace-lifecycle
// port BEFORE the shared renderer mounts, so the panel reads the Host's
// checkout and integration observations through the port instead of
// rebuilding the mapping here.
configureWorkspaceLifecycle(createElectronWorkspaceLifecyclePort());

// A detached panel window loads this same entry point. Its preload context
// names the pane it hosts, so mount ONLY that panel: booting the full <App/>
// here would start session subscriptions, scheduled-turn consumers and the
// mailbox listener a second time, against state that belongs to the main
// window.
const panelContext = window.electronAPI?.panelWindow?.context;
const isDetachedPanel = Boolean(panelContext?.paneId && panelContext?.pageId);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isDetachedPanel ? <DetachedPanelRoot /> : <App onReady={hideBootSplash} />}
  </React.StrictMode>,
);
