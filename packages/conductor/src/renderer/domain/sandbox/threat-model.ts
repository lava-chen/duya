export const DYNAMIC_WIDGET_THREAT_MODEL = {
  version: "1.0",
  lastUpdated: "2026-05-07",

  threats: {
    xss: {
      name: "Cross-Site Scripting (XSS)",
      severity: "critical",
      description: "Dynamic widget HTML must not access host DOM or execute arbitrary scripts",
      mitigations: [
        "Isolate widget content in sandboxed iframe",
        "Sanitize all HTML/SVG before rendering",
        "Strip script tags, event handlers, and javascript: URLs",
        "No access to parent window or opener",
      ],
    },
    network: {
      name: "Network Access",
      severity: "high",
      description: "Dynamic widgets must not make arbitrary network requests",
      mitigations: [
        "Set Content-Security-Policy: default-src 'none'",
        "Block fetch, XHR, WebSocket, EventSource connections",
        "No form submissions or navigation",
      ],
    },
    storage: {
      name: "Storage Access",
      severity: "high",
      description: "Dynamic widgets must not use browser storage APIs",
      mitigations: [
        "Block localStorage and sessionStorage access",
        "Sandboxed iframe has no storage access by default",
      ],
    },
    hostApi: {
      name: "Host API Access",
      severity: "critical",
      description: "Dynamic widgets must not access Node.js, Electron, or other host APIs",
      mitigations: [
        "iframe runs in browser context, no Node.js APIs available",
        "No preload script for dynamic widget iframes",
        "No Electron IPC access",
      ],
    },
    resource: {
      name: "Resource Exhaustion",
      severity: "medium",
      description: "Dynamic widgets must be limited in CPU, memory, and rendering",
      mitigations: [
        "Limit widget render size (max dimensions)",
        "Limit render update frequency (throttle intervals)",
        "Timeout and reclamation for hung iframes",
        "Disable heavy CSS features (animations, transitions) by default",
      ],
    },
    data: {
      name: "Data Access",
      severity: "high",
      description: "Dynamic widgets can only access their own data via controlled postMessage",
      mitigations: [
        "postMessage channel only transmits current widget data",
        "postMessage messages are schema-validated",
        "No access to other widgets' data or canvas state",
        "Widget cannot initiate Conductor actions",
      ],
    },
    permissions: {
      name: "Permission Escalation",
      severity: "critical",
      description: "Dynamic widgets cannot perform Conductor actions or use Agent tools",
      mitigations: [
        "Dynamic widgets cannot call conductor:* tools",
        "All tool calls go through Agent, not widgets",
        "User must confirm before dynamic widget creation",
      ],
    },
  },

  sandbox: {
    renderMode: "iframe" as const,
    sandboxAttributes: [
      "allow-scripts",
      // NOT allow-same-origin, NOT allow-forms, NOT allow-popups,
      // NOT allow-top-navigation, NOT allow-modals, NOT allow-presentation
    ],
    csp: "default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none';",
    dimensionLimits: {
      maxWidth: 1200,
      maxHeight: 900,
      defaultWidth: 400,
      defaultHeight: 300,
    },
    updateThrottleMs: 500,
    iframeTimeoutMs: 30000,
  },
} as const;

export type DynamicWidgetThreat = keyof typeof DYNAMIC_WIDGET_THREAT_MODEL.threats;

export interface DynamicWidgetSecurityContext {
  sourceHtml: string;
  sanitizedHtml: string;
  warnings: string[];
  blocked: string[];
  passedThreatChecks: DynamicWidgetThreat[];
  failedThreatChecks: DynamicWidgetThreat[];
}

export function createEmptySecurityContext(): DynamicWidgetSecurityContext {
  return {
    sourceHtml: "",
    sanitizedHtml: "",
    warnings: [],
    blocked: [],
    passedThreatChecks: [],
    failedThreatChecks: [],
  };
}
