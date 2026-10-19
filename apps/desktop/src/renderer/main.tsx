import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "@duya/ui";
import "@duya/ui/styles.css";

function hideBootSplash() {
  document.getElementById("duya-boot-splash")?.setAttribute("data-hidden", "true");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App onReady={hideBootSplash} />
  </React.StrictMode>,
);
