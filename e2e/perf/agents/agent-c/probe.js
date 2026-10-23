/**
 * In-page performance probe for the Agent C (React state-update) measurement.
 *
 * Installed into the renderer before the measurement window opens. It collects
 * the metrics the plan's metric contract names:
 *
 *   - `interact.p50_ms` / `interact.p95_ms` — keystroke -> painted frame.
 *   - `frame.p95_ms` — p95 of adjacent requestAnimationFrame intervals.
 *   - `dom.mutations` — MutationObserver `childList` change count.
 *   - `commit.count` — MutationObserver change BATCHES. The production build
 *     ships no React Profiler, so per the metric contract this is the honest
 *     substitute; the report must say so.
 *   - `dom.nodes` — `document.getElementsByTagName('*').length`.
 *   - `longtask.count` / `longtask.total_ms` — PerformanceObserver longtask.
 *
 * Plus one structural metric the DOM counters cannot express: how many React
 * fibers actually re-rendered. A re-render that produces identical DOM leaves
 * no mutation behind, so the sidebar could burn work on every keystroke
 * without moving a single node. The production build still attaches
 * `__reactFiber$` to host nodes, so the fiber tree is walkable from the page.
 *
 * HOW A RE-RENDER IS DETECTED
 *
 * React keeps TWO fiber objects per component and alternates between them on
 * every commit, so a fiber cannot be identified by object identity: a
 * component that re-renders on every commit would always look "new", and a
 * component that never re-renders would look "changed". The probe therefore
 * identifies a component by its POSITION in the tree (a numeric path) and
 * compares the committed props object and hook-state head against the
 * previous sample:
 *
 *   - a parent-driven re-render hands the child a fresh props object, so
 *     `memoizedProps` changes identity;
 *   - a state-driven re-render reuses the props object but rebuilds the hook
 *     list, so `memoizedState` changes identity.
 *
 * The tree is sampled once per animation frame, which is finer than the
 * keystroke cadence, so every commit is observed exactly once.
 *
 * COST: the sample walks the SIDEBAR subtree only. Walking the whole tree
 * every frame cost more than a frame's budget and slowed the app under
 * measurement by ~4x, which would have invalidated the latency numbers. The
 * sidebar subtree is the region this measurement is about; the page-wide
 * commit count comes from the MutationObserver instead.
 */
(() => {
  if (window.__duyaPerfProbe) return;

  const state = {
    // Frame intervals in ms.
    frames: [],
    // Keystroke -> painted frame durations in ms.
    interactions: [],
    // childList mutation count.
    mutations: 0,
    // MutationObserver callback invocations (the commit.count proxy).
    mutationBatches: 0,
    longtasks: [],
    // Elements that took focus away from the composer mid-run.
    focusLosses: [],
    // Sidebar fibers that re-rendered during the measurement window.
    renders: { sidebar: 0, column: 0 },
    // Frames sampled while measuring.
    samples: 0,
    // Set while the measurement window is open.
    measuring: false,
  };
  window.__duyaPerfProbe = state;

  // ── frame sampler + interaction latency + render sampling ─────────────
  let lastFrame = 0;
  // Keystrokes waiting for the next painted frame.
  const pendingInteractions = [];
  const tick = (timestamp) => {
    if (lastFrame) state.frames.push(timestamp - lastFrame);
    lastFrame = timestamp;
    if (state.measuring) sampleSidebar();
    if (pendingInteractions.length) {
      // A task queued from rAF runs after the frame has been committed and
      // painted, which is the "that frame finished drawing" boundary.
      const batch = pendingInteractions.splice(0, pendingInteractions.length);
      setTimeout(() => {
        const done = performance.now();
        for (const startedAt of batch) state.interactions.push(done - startedAt);
      }, 0);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  document.addEventListener(
    'input',
    (event) => {
      if (!state.measuring) return;
      const target = event.target;
      if (!target || target.getAttribute?.('role') !== 'textbox') return;
      pendingInteractions.push(performance.now());
    },
    true,
  );

  // Focus can be taken away from the composer while the run is in flight.
  // Record who took it, so the report can say whether the harness had to
  // restore focus (and how often) instead of silently measuring less.
  document.addEventListener(
    'focusout',
    () => {
      if (!state.measuring) return;
      const active = document.activeElement;
      state.focusLosses.push(
        active ? `${active.tagName}.${active.className || ''}`.slice(0, 80) : 'none',
      );
    },
    true,
  );

  // ── DOM mutation batches ───────────────────────────────────────────────
  const observer = new MutationObserver((records) => {
    if (!state.measuring) return;
    for (const record of records) {
      if (record.type === 'childList') state.mutations += 1;
    }
    state.mutationBatches += 1;
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });

  // ── long tasks ─────────────────────────────────────────────────────────
  try {
    new PerformanceObserver((list) => {
      if (!state.measuring) return;
      for (const entry of list.getEntries()) state.longtasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask is Chromium-only and may be unavailable; the metric is then
    // reported as "not collected" rather than faked.
  }

  // ── fiber-level re-render detection ────────────────────────────────────
  //
  // WHAT IS COUNTED
  //
  // `aside.app-sidebar` is the root element the sidebar component renders.
  // React creates a fresh element (and therefore a fresh props object) for it
  // on every render of that component, so the host fiber's committed props
  // object changes identity exactly when the SIDEBAR re-renders — and it
  // does NOT change when the sidebar bails out (React reuses the element).
  // One fiber is one comparison per frame, so the probe costs nothing.
  //
  // A subtree walk would answer the same question but cost more than a
  // frame's budget: walking the whole tree every frame slowed the app under
  // measurement by ~4x and invalidated the latency numbers.
  //
  // WHY NOT BY FIBER IDENTITY
  //
  // React keeps two fiber objects per component and alternates between them
  // on every commit, so a fiber cannot be tracked by object identity. The
  // probe compares the committed props object and hook-state head of the
  // SAME logical element across samples instead:
  //
  //   - a parent-driven re-render hands the child a fresh props object, so
  //     `memoizedProps` changes identity;
  //   - a state-driven re-render reuses the props object but rebuilds the
  //     hook list, so `memoizedState` changes identity.
  const fiberKeyCache = new WeakMap();
  const fiberKeyOf = (node) => {
    if (!node) return undefined;
    const cached = fiberKeyCache.get(node);
    if (cached !== undefined) return cached;
    const key = Object.keys(node).find((name) => name.startsWith('__reactFiber$'));
    fiberKeyCache.set(node, key);
    return key;
  };

  const fiberOfSelector = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const key = fiberKeyOf(node);
    return key ? node[key] : null;
  };

  // The sidebar component's own output element, and the sidebar column's
  // direct children (the rail and the sidebar itself).
  const SIDEBAR_ROOT = 'aside.app-sidebar';
  const SIDEBAR_COLUMN = '.app-sidebar-column';

  let previousHostProps = null;
  let previousHostHookState = null;
  let previousComponentProps = null;
  let previousComponentHookState = null;
  let previousColumnProps = null;

  const sampleSidebar = () => {
    const host = fiberOfSelector(SIDEBAR_ROOT);
    if (!host) return;
    // The host fiber of `aside.app-sidebar` is the element the sidebar
    // component rendered; its parent fiber IS the sidebar component.
    const component = host.return;
    const hostProps = host.memoizedProps;
    const hostHookState = host.memoizedState;
    const componentProps = component ? component.memoizedProps : null;
    const componentHookState = component ? component.memoizedState : null;
    const changed =
      (previousHostProps !== null &&
        (previousHostProps !== hostProps || previousHostHookState !== hostHookState)) ||
      (previousComponentProps !== null &&
        (previousComponentProps !== componentProps ||
          previousComponentHookState !== componentHookState));
    if (changed) state.renders.sidebar += 1;
    previousHostProps = hostProps;
    previousHostHookState = hostHookState;
    previousComponentProps = componentProps;
    previousComponentHookState = componentHookState;

    // Secondary signal: the sidebar column's direct children. The rail is
    // not memoised, so it changes on every shell render; counting the whole
    // set shows how much of the shell churn reaches the sidebar column.
    const column = fiberOfSelector(SIDEBAR_COLUMN);
    if (column) {
      let child = column.child;
      let index = 0;
      while (child && index < 8) {
        const childProps = child.memoizedProps;
        if (previousColumnProps && previousColumnProps[index] !== childProps) {
          state.renders.column += 1;
        }
        previousColumnProps[index] = childProps;
        index += 1;
        child = child.sibling;
      }
    }
    state.samples += 1;
  };

  window.__duyaPerfReset = () => {
    state.frames.length = 0;
    state.interactions.length = 0;
    state.mutations = 0;
    state.mutationBatches = 0;
    state.longtasks.length = 0;
    state.focusLosses.length = 0;
    state.renders.sidebar = 0;
    state.renders.column = 0;
    state.samples = 0;
    pendingInteractions.length = 0;
    previousHostProps = null;
    previousHostHookState = null;
    previousComponentProps = null;
    previousComponentHookState = null;
    previousColumnProps = [];
    // Prime so the first sample does not count as a change.
    sampleSidebar();
    state.measuring = true;
  };

  window.__duyaPerfRead = () => {
    state.measuring = false;
    return {
      frames: state.frames.slice(),
      interactions: state.interactions.slice(),
      mutations: state.mutations,
      mutationBatches: state.mutationBatches,
      longtasks: state.longtasks.slice(),
      focusLosses: state.focusLosses.slice(),
      renders: { ...state.renders },
      samples: state.samples,
      domNodes: document.getElementsByTagName('*').length,
    };
  };
})();
