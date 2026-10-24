/**
 * e2e/perf/lib/collector-source.mjs — the renderer-side collector source.
 *
 * WHY A STRING AND NOT A FUNCTION
 *
 * The collector has to be installed in the renderer BEFORE the app's own code
 * runs, otherwise the first paint and the first commit are already over and
 * the numbers describe a boot that never happened. `page.addInitScript`
 * takes a source string, and a string cannot close over anything from this
 * module — so the collector is written as a self-contained IIFE and the
 * configuration it needs is passed through the DOM (see `collector.mjs`,
 * which writes `window.__DUYA_PERF_OPTIONS__` before the init script runs).
 *
 * WHAT IT MEASURES (the metric contract from the performance plan)
 *
 *   frame times      rAF timestamps; the gap between neighbours is the frame
 *                     interval, and its p95 is `frame.p95_ms`.
 *   long tasks       PerformanceObserver('longtask') — `longtask.count` and
 *                     `longtask.total_ms`.
 *   commits          MutationObserver childList batches. A production build
 *                     has no React Profiler, so this is the documented
 *                     substitute for React commit counts; one batch is one
 *                     microtask checkpoint, which is the closest observable
 *                     proxy for one React commit.
 *   input latency    keydown -> the frame in which the edit was painted. The
 *                     paint of frame N is complete before the callback of
 *                     frame N+1 runs, so a double rAF is the honest proxy for
 *                     "the frame finished painting".
 *   DOM size         `document.getElementsByTagName('*').length` on demand.
 *   WebGL state      every WebGL context the app created is tracked, so the
 *                     harness can lose them for real (GPU scenario) and read
 *                     back whether the app noticed.
 *
 * WHAT IT DOES NOT DO
 *
 * It never touches product code, never changes product behaviour, and never
 * swallows errors. Everything it reports is an observation.
 */
export const COLLECTOR_SOURCE = `(() => {
  if (window.__duyaPerf && window.__duyaPerf.version === 1) return;

  var options = window.__DUYA_PERF_OPTIONS__ || {};
  var MAX_FRAMES = options.maxFrames || 60000;
  var MAX_LONG_TASKS = options.maxLongTasks || 20000;
  var MAX_KEYS = options.maxKeys || 20000;

  var state = {
    version: 1,
    installedAt: performance.now(),
    timeOrigin: performance.timeOrigin,
    frames: [],
    frameCount: 0,
    longTasks: [],
    mutationBatches: 0,
    mutationRecords: 0,
    keyLatencies: [],
    labels: [],
    webglContexts: [],
    consoleErrors: []
  };

  function noteFrame(t) {
    state.frameCount += 1;
    if (state.frames.length < MAX_FRAMES) state.frames.push(t);
    requestAnimationFrame(noteFrame);
  }
  requestAnimationFrame(noteFrame);

  try {
    var longTaskObserver = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        if (state.longTasks.length < MAX_LONG_TASKS) {
          state.longTasks.push({ start: entries[i].startTime, duration: entries[i].duration });
        }
      }
    });
    longTaskObserver.observe({ type: 'longtask', buffered: true });
  } catch (err) {
    state.longTaskObserverError = String(err);
  }

  if (options.mutationObserver !== false) {
    try {
      var mutationObserver = new MutationObserver(function (records) {
        state.mutationBatches += 1;
        state.mutationRecords += records.length;
      });
      // The DOCUMENT is the target, not documentElement: an init script runs
      // before the root element exists, and observing a null target throws —
      // which silently costs the whole commit metric.
      mutationObserver.observe(document, {
        childList: true,
        subtree: true
      });
    } catch (err) {
      state.mutationObserverError = String(err);
    }
  }

  // Track every WebGL context the app asks for, so the GPU scenario can lose
  // a REAL context instead of simulating the loss.
  try {
    var originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      var ctx = originalGetContext.apply(this, arguments);
      try {
        if (ctx && typeof type === 'string' && type.toLowerCase().indexOf('webgl') !== -1) {
          if (state.webglContexts.indexOf(ctx) === -1) state.webglContexts.push(ctx);
        }
      } catch (err) {
        /* a context that cannot be tracked is not a failure of the measurement */
      }
      return ctx;
    };
  } catch (err) {
    state.webglPatchError = String(err);
  }

  document.addEventListener('keydown', function (event) {
    var t0 = event.timeStamp;
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (state.keyLatencies.length < MAX_KEYS) {
          state.keyLatencies.push({ t0: t0, latency: performance.now() - t0, key: event.key });
        }
      });
    });
  }, true);

  window.addEventListener('error', function (event) {
    state.consoleErrors.push(String(event.message || 'error'));
  });
  window.addEventListener('unhandledrejection', function (event) {
    state.consoleErrors.push('unhandledrejection: ' + String(event.reason));
  });

  // When did the composer become typeable? The harness polls for it from the
  // outside too, but only an in-page observation has frame-level resolution
  // and can be expressed relative to the document's own time origin.
  var composerReadyAt = null;
  function checkComposer() {
    if (composerReadyAt !== null) return;
    var el = document.querySelector('[role="textbox"][contenteditable="true"]');
    if (el && el.isConnected) {
      composerReadyAt = performance.now();
      return;
    }
    setTimeout(checkComposer, 16);
  }
  checkComposer();

  window.__duyaPerf = {
    version: 1,
    reset: function () {
      state.frames = [];
      state.frameCount = 0;
      state.longTasks = [];
      state.mutationBatches = 0;
      state.mutationRecords = 0;
      state.keyLatencies = [];
      state.labels = [];
    },
    mark: function (label) {
      state.labels.push({ label: label, t: performance.now() });
    },
    loseWebglContexts: function () {
      var lost = 0;
      for (var i = 0; i < state.webglContexts.length; i++) {
        try {
          var ctx = state.webglContexts[i];
          var ext = ctx.getExtension('WEBGL_lose_context');
          if (ext) {
            ext.loseContext();
            lost += 1;
          }
        } catch (err) {
          /* ignore */
        }
      }
      return lost;
    },
    webglState: function () {
      var out = [];
      for (var i = 0; i < state.webglContexts.length; i++) {
        var ctx = state.webglContexts[i];
        var lost = false;
        try {
          lost = typeof ctx.isContextLost === 'function' ? ctx.isContextLost() : false;
        } catch (err) {
          lost = false;
        }
        out.push(lost);
      }
      return out;
    },
    snapshot: function () {
      return {
        version: state.version,
        installedAt: state.installedAt,
        timeOrigin: state.timeOrigin,
        now: performance.now(),
        frames: state.frames.slice(),
        frameCount: state.frameCount,
        longTasks: state.longTasks.slice(),
        mutationBatches: state.mutationBatches,
        mutationRecords: state.mutationRecords,
        keyLatencies: state.keyLatencies.slice(),
        labels: state.labels.slice(),
        composerReadyAt: composerReadyAt,
        domNodes: document.getElementsByTagName('*').length,
        webglContextsLost: state.webglContexts.map(function (ctx) {
          try {
            return typeof ctx.isContextLost === 'function' ? ctx.isContextLost() : false;
          } catch (err) {
            return false;
          }
        }),
        pageErrors: state.consoleErrors.slice(),
        longTaskObserverError: state.longTaskObserverError || null,
        mutationObserverError: state.mutationObserverError || null
      };
    }
  };
})();`;
