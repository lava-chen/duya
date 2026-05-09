"use client";

import { BridgeSection } from "@/components/settings";

export function BridgeView() {
  return (
    <div className="page">
      <div className="page-header">
        <div className="header-content">
          <div className="header-icon">
            {/* Bridge icon */}
          </div>
          <div>
            <h1>Bridge</h1>
            <p>External platform integrations</p>
          </div>
        </div>
      </div>
      <BridgeSection />
    </div>
  );
}