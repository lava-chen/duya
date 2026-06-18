export interface SecureIframeMessage {
  type: string;
  payload: unknown;
  id?: string;
}

export const SECURE_IFRAME_MESSAGE_TYPES = {
  READY: "secure:ready",
  RESIZE: "secure:resize",
  DATA_UPDATE: "secure:data-update",
  THEME_UPDATE: "secure:theme-update",
  ERROR: "secure:error",
  PING: "secure:ping",
  PONG: "secure:pong",
} as const;

export interface SecureIframeReadyPayload {
  initialHeight: number;
  initialWidth: number;
}

export interface SecureIframeResizePayload {
  width: number;
  height: number;
}

export interface SecureIframeDataPayload {
  widgetId: string;
  data: Record<string, unknown>;
}

export interface SecureIframeThemePayload {
  theme: "light" | "dark";
  cssVariables: Record<string, string>;
}

export interface SecureIframeErrorPayload {
  code: string;
  message: string;
  details?: string;
}

export interface SecureIframeChannelSchema {
  [SECURE_IFRAME_MESSAGE_TYPES.READY]: {
    payload: SecureIframeReadyPayload;
    direction: "widget-to-host";
  };
  [SECURE_IFRAME_MESSAGE_TYPES.RESIZE]: {
    payload: SecureIframeResizePayload;
    direction: "widget-to-host";
  };
  [SECURE_IFRAME_MESSAGE_TYPES.DATA_UPDATE]: {
    payload: SecureIframeDataPayload;
    direction: "host-to-widget";
  };
  [SECURE_IFRAME_MESSAGE_TYPES.THEME_UPDATE]: {
    payload: SecureIframeThemePayload;
    direction: "host-to-widget";
  };
  [SECURE_IFRAME_MESSAGE_TYPES.ERROR]: {
    payload: SecureIframeErrorPayload;
    direction: "both";
  };
  [SECURE_IFRAME_MESSAGE_TYPES.PING]: {
    payload: { timestamp: number };
    direction: "host-to-widget";
  };
  [SECURE_IFRAME_MESSAGE_TYPES.PONG]: {
    payload: { timestamp: number };
    direction: "widget-to-host";
  };
}

export function createSecureIframeMessage<T extends keyof SecureIframeChannelSchema>(
  type: T,
  payload: SecureIframeChannelSchema[T]["payload"],
  id?: string,
): SecureIframeMessage {
  return { type, payload, id };
}

export function validateIframeMessage(message: unknown): message is SecureIframeMessage {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  if (typeof m.type !== "string") return false;
  return true;
}

export function isAllowedOrigin(origin: string): boolean {
  return origin === window.location.origin;
}

export function generateIframeHtmlContent(
  bodyHtml: string,
  csp: string,
  themeVariables: Record<string, string>,
): string {
  const cssVarBlock = Object.entries(themeVariables)
    .map(([key, value]) => `${key}: ${value};`)
    .join("\n      ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style>
    :root {
      ${cssVarBlock}
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      color: var(--text, #333333);
      background-color: var(--bg-canvas, #ffffff);
      overflow: hidden;
      width: 100%;
      height: 100%;
    }
  </style>
  <script>
    // Minimal secure postMessage bridge
    (function() {
      var messageQueue = [];
      var isProcessing = false;

      function processMessage(type, payload) {
        switch (type) {
          case '${SECURE_IFRAME_MESSAGE_TYPES.DATA_UPDATE}':
            window.dispatchEvent(new CustomEvent('widget:data-update', { detail: payload }));
            break;
          case '${SECURE_IFRAME_MESSAGE_TYPES.THEME_UPDATE}':
            window.dispatchEvent(new CustomEvent('widget:theme-update', { detail: payload }));
            break;
          default:
            break;
        }
      }

      function sendToParent(type, payload, id) {
        try {
          window.parent.postMessage({ type: type, payload: payload, id: id }, window.location.origin);
        } catch (err) {
          // Silently fail - no network access available
        }
      }

      // Expose secure API to widget content
      window.__duyaWidget = {
        sendResize: function(w, h) {
          if (typeof w !== 'number' || typeof h !== 'number') return;
          if (w < 0 || h < 0 || w > 20000 || h > 20000) return;
          sendToParent('${SECURE_IFRAME_MESSAGE_TYPES.RESIZE}', { width: w, height: h });
        },
        sendError: function(code, message) {
          sendToParent('${SECURE_IFRAME_MESSAGE_TYPES.ERROR}', { code: String(code), message: String(message) });
        },
        sendPong: function(ts) {
          sendToParent('${SECURE_IFRAME_MESSAGE_TYPES.PONG}', { timestamp: ts });
        },
        _queueMessage: function(msg) {
          messageQueue.push(msg);
          processNext();
        }
      };

      function processNext() {
        if (isProcessing || messageQueue.length === 0) return;
        isProcessing = true;
        var next = messageQueue.shift();
        try {
          processMessage(next.type, next.payload);
        } catch (err) {
          // Catch errors in widget code
        }
        isProcessing = false;
        if (messageQueue.length > 0) {
          setTimeout(processNext, 0);
        }
      }

      window.addEventListener('message', function(event) {
        if (event.source !== window.parent) return;
        try {
          var msg = event.data;
          if (msg && typeof msg.type === 'string') {
            __duyaWidget._queueMessage(msg);
          }
        } catch (err) {
          // Ignore invalid messages
        }
      });

      // Signal ready
      var html = document.documentElement;
      var initialHeight = document.body.scrollHeight || html.scrollHeight || 300;

      sendToParent('${SECURE_IFRAME_MESSAGE_TYPES.READY}', {
        initialHeight: Math.min(Math.max(initialHeight, 100), 2000),
        initialWidth: document.body.scrollWidth || html.scrollWidth || 400
      });
    })();
  </script>
</head>
<body>
  ${bodyHtml}
</body>
</html>`;
}

export function DEFAULT_CSP(): string {
  return "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; frame-src 'none'; object-src 'none';";
}
