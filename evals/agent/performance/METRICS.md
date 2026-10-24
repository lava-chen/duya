# Agent core performance metric map

The lab measures the Agent execution path independently of Desktop and terminal rendering. It follows the method in Anthropic's performance write-up: first define a common user path and its boundaries, then find stable proxies, and only promote a proxy to a regression gate after repeated measurements show that it predicts real latency or resource cost.

## Metric families

| Layer | Primary latency | Stable workload proxies | Resource / pressure metrics | Coverage |
| --- | --- | --- | --- | --- |
| RunEngine | execute → first model request ready; full deterministic run | model requests, turns, tool dispatches, context assembly calls, output calls, event count | process CPU, RSS/heap delta; concurrent run fairness and throughput | Measured in `run-core.mjs` |
| Context and transcript | assembly and request-ready cost by history size | messages scanned/handed off, message bytes, tool schema count/bytes, request message count | heap delta; later add provider token estimate and persisted read bytes | Synthetic 1/100/1K/10K history scale in `run-core.mjs`; production durable restore remains open |
| Tool catalog | register, snapshot, project definitions to provider shape | tool count, schema bytes, catalog revision | CPU and allocation slope as catalog grows | Production `ToolRegistry` in `run-io.mjs`; connector/MCP discovery remains open |
| Tool round trip | model response → dispatch → result → next request | tool calls, drain calls, result records, model turns, event count | per-executor queue/wait/runtime, error/retry/cancel rates | Engine path at 1/10/50 scripted calls; production executors not yet included |
| Event production | engine event publish cost by event burst | frames, payload bytes, frame type mix | publish CPU, producer delay | Engine sink burst 20/100/500 frames |
| Event fan-out | publish and drain time by subscriber count | offered/delivered frames, deliveries per event, serialized bytes | queue high-water bytes/frames, dropped/merged frames, gaps, pause/disconnect | Production `FanOutBroker` at 1/2/4/10 subscribers plus a delayed durable consumer under 8 KiB/32-frame bounds; real HTTP clients and producer pause propagation remain open |
| Durable event store | append and replay time by batch size | rows written/read, append calls, transaction batches, envelope bytes | storage mode, write throughput, WAL/file growth | Production `RunStore` + SQLite at 20/100/500 events, batch vs one-event appends; Host bridge overhead remains open |
| Worker lifecycle | Host accept → fork → worker ready → context ready → first provider request | spawns/run, module init, DB bridge requests, cache hit/miss | cold/warm RSS, CPU, startup queue delay | Measured end to end in `runtime-e2e.test.ts` (real worker bundle, real Host): accept, dispatch, worker boot, provider request, first token, plus the worker's own log phase gaps. The transcript DB bridge domain is still missing, so the durable-restore leg stays open |
| End-to-end turn | submit → first token received → first token painted; model asks for a tool → tool runs → model asked again → final text; per-event Host mint → client receipt → paint | provider requests per turn, tool calls, event count by durability and type | arrival gap distribution, client-to-paint latency, worker/Host log phase gaps | `runtime-e2e.test.ts` against a scripted provider; the provider's own latency is a fixture parameter and is reported separately |
| Multi-run scheduling | Host accept → per-run ready/first event/settle | queue depth, workers active, run attempts, event count per run | throughput, per-run p50/p95/max, Jain fairness, event-loop utilization, process CPU/RSS | Single-process Engine concurrency 1/4/10 is diagnostic only; independent Worker/process contention remains open |
| Provider | request sent → first chunk and completion | request/response bytes, tokens, retries | provider wait, stream gaps | Deterministic provider is the default control; real-provider runs are separate trend evidence, never a code-only gate |
| TUI | construct/start → first complete frame; input byte → painted frame; event delta → next frame | frame count, UTF-8 bytes/frame, input samples, stream deltas, transcript blocks/lines | paint interval p50/p95/max, suite CPU and RSS/heap delta, cold/warm transcript cache hit/miss | In-process production `TUIApp` + `TranscriptRenderer` at 80×24 in `evals/agent/performance/tui.test.ts`; OS terminal emulator and real CLI bundle startup remain open |

## Boundary and clock rules

- Use monotonic durations local to the process that owns the span. Correlate processes with `runId`/`traceId`; never subtract raw timestamps from clocks in different processes.
- Keep nested spans separate from wall-clock totals. Summing nested spans double-counts work.
- Label scripted-provider wall time as Agent overhead under that fixture. It excludes network and model inference and is not user-perceived response time.
- Keep TUI measurements as a separate report from Agent core. In-process terminal-stream timings end before the operating-system terminal emulator; use the PTY suite and real terminals as separate end-to-end evidence.
- Distinguish cold Worker spawn, warm reuse, restored session, and same-process RunEngine execution. They answer different questions.
- Preserve correctness with every performance sample: expected model calls, tool calls, event sequence, durable row count, and replay count must match the fixture.
- Keep estimated serialized bytes separate from stable work counts. Dynamic event fields can alter bytes by a few bytes without changing the work performed.

## Reading a result

The current script creates a performance map, not a single score. Look for a curve that grows faster than the workload (for example, 10× history causing much more than 10× preparation time), a high cost per operation, duplicate work counters, or a pressure metric that rises before latency does. Repeat on the same Node version, OS, architecture, storage mode, and quiet machine. Keep enough samples for p95; do not infer a regression from one short run.

For each suspected hotspot, record the fixed fixture, correctness assertions, proxy, wall-clock phases, and before/after reports. A proxy is eligible for a ratchet only after its changes repeatedly move the matching wall-clock or CPU metric in the expected direction without worsening first-event latency, correctness, or resource use.

## Remaining measurement work

The largest gap left in the production process chain is the durable side: the Worker DB bridge still lacks message-write domains, so a production Worker cannot yet complete its normal durable transcript path through standalone Host, and the runtime suite's transcript leg stays unmeasured. Still open: Host SQLite transaction batching and WAL growth in a real run, slow-consumer queue high-water over a real SSE socket, reconnects and `Last-Event-ID` behaviour under load, and true multi-process contention at 1/4/10/25 concurrent runs. The worker's own log gives phase gaps but not CPU attribution, so "which phase burns the CPU" still needs a profiler.

The runtime suite's numbers come from a scripted provider and a scripted tool. A real provider adds network and model latency on top; those are trend evidence, never a code-only gate.
