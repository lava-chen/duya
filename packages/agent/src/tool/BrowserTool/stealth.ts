/**
 * Stealth anti-detection module.
 *
 * Generates JS code that patches browser globals to hide automation
 * fingerprints (e.g. navigator.webdriver, missing chrome object, empty
 * plugin list). Injected before page scripts run so that websites cannot
 * detect CDP / extension-based control.
 *
 * Inspired by puppeteer-extra-plugin-stealth and OpenCLI.
 */

let _cachedStealthJs: string | undefined;

export function generateStealthJs(): string {
  if (_cachedStealthJs !== undefined) return _cachedStealthJs;
  return (_cachedStealthJs = `
    (() => {
      // Guard: prevent double-injection across separate CDP evaluations.
      const _gProto = EventTarget.prototype;
      const _gKey = '__lsn';
      if (_gProto[_gKey]) return 'skipped';
      try {
        Object.defineProperty(_gProto, _gKey, { value: true, enumerable: false, configurable: true });
      } catch {}

      // 1. navigator.webdriver -> false
      try {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => false,
          configurable: true,
        });
      } catch {}

      // 2. window.chrome stub
      try {
        if (!window.chrome) {
          window.chrome = {
            runtime: {
              onConnect: { addListener: () => {}, removeListener: () => {} },
              onMessage: { addListener: () => {}, removeListener: () => {} },
            },
            loadTimes: () => ({}),
            csi: () => ({}),
          };
        }
      } catch {}

      // 3. navigator.plugins - fake population only if empty
      try {
        if (!navigator.plugins || navigator.plugins.length === 0) {
          const fakePlugins = [
            { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
            { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
            { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: '' },
            { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: '' },
          ];
          fakePlugins.item = (i) => fakePlugins[i] || null;
          fakePlugins.namedItem = (n) => fakePlugins.find(p => p.name === n) || null;
          fakePlugins.refresh = () => {};
          Object.defineProperty(navigator, 'plugins', {
            get: () => fakePlugins,
            configurable: true,
          });
        }
      } catch {}

      // 4. navigator.languages - guarantee non-empty
      try {
        if (!navigator.languages || navigator.languages.length === 0) {
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en'],
            configurable: true,
          });
        }
      } catch {}

      // 5. Permissions.query - normalize notification permission
      try {
        const origQuery = window.Permissions?.prototype?.query;
        if (origQuery) {
          window.Permissions.prototype.query = function (parameters) {
            if (parameters?.name === 'notifications') {
              return Promise.resolve({ state: Notification.permission, onchange: null });
            }
            return origQuery.call(this, parameters);
          };
        }
      } catch {}

      // 6. Clean automation artifacts
      try {
        delete window.__playwright;
        delete window.__puppeteer;
        for (const prop of Object.getOwnPropertyNames(window)) {
          if (prop.startsWith('cdc_') || prop.startsWith('__cdc_')) {
            try { delete window[prop]; } catch {}
          }
        }
      } catch {}

      // 7. CDP stack trace cleanup
      try {
        const _origDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
        const _cdpPatterns = [
          'puppeteer_evaluation_script',
          'pptr:',
          'debugger://',
          '__playwright',
          '__puppeteer',
        ];
        if (_origDescriptor && _origDescriptor.get) {
          Object.defineProperty(Error.prototype, 'stack', {
            get: function () {
              const raw = _origDescriptor.get.call(this);
              if (typeof raw !== 'string') return raw;
              return raw.split('\\n').filter(line =>
                !_cdpPatterns.some(p => line.includes(p))
              ).join('\\n');
            },
            configurable: true,
          });
        }
      } catch {}

      // 8. Anti-debugger statement trap
      try {
        const _OrigFunction = Function;
        const _debuggerRe = /(?:^|(?<=[;{}\\n\\r]))\\s*debugger\\s*;?/g;
        const _cleanDebugger = (src) => typeof src === 'string' ? src.replace(_debuggerRe, '') : src;
        const _PatchedFunction = function(...args) {
          if (args.length > 0) {
            args[args.length - 1] = _cleanDebugger(args[args.length - 1]);
          }
          if (new.target) {
            return Reflect.construct(_OrigFunction, args, new.target);
          }
          return _OrigFunction.apply(this, args);
        };
        _PatchedFunction.prototype = _OrigFunction.prototype;
        Object.setPrototypeOf(_PatchedFunction, _OrigFunction);
        try { window.Function = _PatchedFunction; } catch {}

        const _origEval = window.eval;
        const _patchedEval = function(code) {
          return _origEval.call(this, _cleanDebugger(code));
        };
        try { window.eval = _patchedEval; } catch {}
      } catch {}

      // 9. window.outerWidth/outerHeight defense
      try {
        const _normalWidthDelta = window.outerWidth - window.innerWidth;
        const _normalHeightDelta = window.outerHeight - window.innerHeight;
        if (_normalWidthDelta > 100 || _normalHeightDelta > 200) {
          Object.defineProperty(window, 'outerWidth', {
            get: () => window.innerWidth,
            configurable: true,
          });
          const _heightOffset = Math.max(40, Math.min(120, _normalHeightDelta));
          Object.defineProperty(window, 'outerHeight', {
            get: () => window.innerHeight + _heightOffset,
            configurable: true,
          });
        }
      } catch {}

      // 10. Performance API cleanup
      try {
        const _origGetEntries = Performance.prototype.getEntries;
        const _origGetByType = Performance.prototype.getEntriesByType;
        const _origGetByName = Performance.prototype.getEntriesByName;
        const _suspiciousPatterns = ['debugger', 'devtools', '__puppeteer', '__playwright', 'pptr:'];
        const _filterEntries = (entries) => {
          if (!Array.isArray(entries)) return entries;
          return entries.filter(e => {
            const name = e.name || '';
            return !_suspiciousPatterns.some(p => name.includes(p));
          });
        };
        Performance.prototype.getEntries = function() {
          return _filterEntries(_origGetEntries.call(this));
        };
        Performance.prototype.getEntriesByType = function(type) {
          return _filterEntries(_origGetByType.call(this, type));
        };
        Performance.prototype.getEntriesByName = function(name, type) {
          return _filterEntries(_origGetByName.call(this, name, type));
        };
      } catch {}

      // 11. Iframe contentWindow.chrome consistency
      try {
        const _origHTMLIFrame = HTMLIFrameElement.prototype;
        const _origContentWindow = Object.getOwnPropertyDescriptor(_origHTMLIFrame, 'contentWindow');
        if (_origContentWindow && _origContentWindow.get) {
          Object.defineProperty(_origHTMLIFrame, 'contentWindow', {
            get: function() {
              const _w = _origContentWindow.get.call(this);
              if (_w) {
                try {
                  if (!_w.chrome) {
                    Object.defineProperty(_w, 'chrome', {
                      value: window.chrome,
                      writable: true,
                      configurable: true,
                    });
                  }
                } catch {}
              }
              return _w;
            },
            configurable: true,
          });
        }
      } catch {}

      return 'applied';
    })()
  `);
}
