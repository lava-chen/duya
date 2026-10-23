import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@duya/ui";
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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App onReady={hideBootSplash} />
  </React.StrictMode>,
);
