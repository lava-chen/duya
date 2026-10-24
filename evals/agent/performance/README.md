# Agent Performance Lab

This is the headless controller and benchmark scaffold derived from the agreed performance strategy. It measures production Agent Runtime components without Electron, React, terminal rendering, or provider network variance. The TUI can later invoke these commands and display their reports; it does not own the measurements.

## Current coverage

`npm run eval:agent:core` builds workspace packages, runs the shared deterministic Engine and component fixtures, checks call/event/persistence correctness, and writes raw per-run timings plus stage spans to `evals/agent/reports/core-latest.json`. `npm run eval:agent:core:io` reruns production ToolRegistry, RunStore, and FanOutBroker component loads against that report. `npm run eval:agent:core:check` checks the recorder's sync/async timing, error, count, and no-op behavior.

`npm run eval:agent:tui` runs a separate TUI performance suite and writes `evals/agent/reports/tui-latest.json`. It reports TUI construction/start to first frame, input-to-painted-frame latency, stream frame gaps/coalescing and UTF-8 output volume, and cold/warm transcript layout at 2K/10K blocks. `npm run eval:agent:tui:compare -- <baseline.json> <current.json>` compares matching TUI runs. `npm run eval:agent:all` runs the core, TUI and runtime suites. The TUI report is intentionally separate from the Agent-core report so terminal rendering cost cannot hide worker/core changes.

`npm run eval:agent:runtime` writes `evals/agent/reports/runtime-latest.json`. It is the suite that closes the Host/Worker gap: a real `LocalHost`, the PRODUCTION worker bundle forked as its own process, a real HTTP/SSE run-event stream read by the production `HostSessionHttpClient`, the production TUI consumption path (`HostEventStream` → `TUIApp` → tapped terminal stream), and a real tool call — against a local scripted Anthropic-SSE provider so "model time" is a fixture parameter. It splits the timeline into first token (submit → provider request → provider first byte → event received → event painted), tool round trip (model asks → tool runs → model asked again → final text), and event transport (per event, the Host's mint time → the TUI's receipt → its paint). It also reports the worker's and the Host's own log phase gaps, which is the only instrument that can say what the worker was doing during the gap between "the Host dispatched the run" and "the provider was called".

Two clock rules apply to that report: the provider, the Host and the TUI share one monotonic clock, while the worker is a separate process — so the worker-side span is reported as one segment and never differenced across the boundary, except for the gaps INSIDE the worker's own log, which are same-process durations. `envelope.timestamp` is epoch milliseconds (integer), so the Host-side mint span carries ±1 ms of quantisation.

The first fixtures exercise:

- J1 engine start through context assembly and first scripted model request, with a zero-wait scripted provider.
- J2 model tool call, dispatch, result drain/backfill, and next model turn at 1, 10, and 50 calls.
- J3 Engine request preparation with 100/1K/10K synthetic history messages and 20/100/500/1K tool definitions; production ToolRegistry registration and snapshot at the same catalog scales.
- J4 Engine event bursts at 20/100/500 frames, production FanOutBroker delivery to 1/2/4/10 subscribers, and production SQLite RunStore append/replay at 20/100/500 envelopes, comparing one batch transaction with one transaction per event.
- J4 queue pressure with a deliberately delayed durable consumer under 8 KiB/32-frame limits; it checks pause/high-water behavior and verifies every durable frame still arrives.
- J5 same-process RunEngine concurrency at 1/4/10 runs, reporting throughput, per-run latency, Jain fairness, process CPU, event-loop utilization, and heap/RSS deltas.
- Stable boundary counters for model requests/messages, tool dispatch, context assembly, tool schema count and estimated payload bytes, emitted event count and estimated payload bytes, and turn-output port calls.

Each span uses `performance.now()` inside this process. The report records `runId`, commit, Node version, platform, architecture, warmups, and individual runs. No timestamps from another process are subtracted or combined. Payload bytes are JSON size estimates; turn-output counters measure port calls except in the explicit RunStore component fixture. The history fixture measures Engine handling of already-assembled messages, not production disk restore or prompt construction. Provider/network time is intentionally zero in Engine fixtures and should not be interpreted as end-user latency.

The TUI suite uses its existing production `TUIApp` frame harness with an in-memory terminal stream at 80×24. Its frame times stop at the last UTF-8 output write inside the process; they do not include OS terminal emulation, terminal rendering, CLI bundle cold start, or Host/Worker/provider time. `packages/cli/test/tui-pty.test.ts` remains the behavioral PTY acceptance suite and is not included in the microbenchmark report.

`npm run eval:agent:core:compare -- <baseline.json> <current.json> [comparison.json]` compares reports only when the fixture schema and Node/platform/architecture match. It is informational; no CI budget or ratchet is enabled until a repeatable proxy metric has been shown to correlate with real latency.

[`INITIAL_FINDINGS.md`](INITIAL_FINDINGS.md) records the first signals, their limits, and a prioritized list of production measurements to add next. Treat its timings as exploratory component evidence, not performance promises.

Set `PERF_SAMPLES` / `PERF_WARMUPS` for Engine scenarios, `PERF_IO_SAMPLES` / `PERF_IO_WARMUPS` for component scenarios, and `EVAL_CORE_OUT` to choose a report path. Large cases cap their sample counts from `fixtures.json` to keep the 10K-message and 1K-tool cases bounded.

The comparator reports stable workload counters separately from estimated payload-byte deltas. Serialized event size can vary slightly because event envelopes contain runtime values; that variation remains visible as a measurement and does not mark the scripted call counts as a different workload.

## Scope boundary

The core harness does not launch the production Host and Worker as independent processes. It includes real Runtime, ToolRegistry, RunStore/SQLite, and FanOutBroker components, but the Engine context provider and Engine event sink are deterministic fixtures. J3's large history measures the Runtime's work on assembled history arrays; it does not read a restored production transcript. J5 measures same-process Engine scheduling and is not a Worker scheduler/fairness result. Host HTTP queueing, Worker spawn/wake, production prompt/context assembly, Worker→Host IPC, HTTP/SSE consumption, and real multi-process contention are measured by the runtime suite instead (`npm run eval:agent:runtime`), not by the core score. The Worker DB bridge still lacks message-write domains needed for a normal persisted production run; the runtime suite therefore measures a scripted provider and a scripted tool, not a production transcript restore. See [`METRICS.md`](METRICS.md) for the metric map and seam gaps. TUI and Desktop remain diagnostic cross-checks and are not included in the core score.

## Working with measurements

Run several reports on the same quiet machine before treating differences as signal. Keep the JSON reports as experiment artifacts and compare identical fixtures. A lower counter is useful only after correctness is held constant and repeated runs show a corresponding latency or CPU improvement. Do not turn the current wall-clock values into CI thresholds: they mostly measure in-process scheduling and recorder/harness costs around zero-wait ports.
