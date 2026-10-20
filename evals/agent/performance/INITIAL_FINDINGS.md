# Initial Agent core findings

These are exploration results from the first expanded matrix, not release budgets. The run used Node v24.19.0 on Linux x64, 10 warm samples for the ordinary Engine fixtures (large fixtures used 5), and 5 samples for component fixtures. Small sample counts and a shared development machine make p95 noisy. Re-run on a quiet, fixed environment before ranking changes by small timing differences.

The Engine fixtures use an in-process zero-wait model provider. They measure RunEngine work on already assembled inputs; they do not represent provider latency, prompt construction, durable transcript restore, Host/Worker startup, or UI response time. Synthetic history and 1,000-tool cases are stress probes, not claims about normal user sessions. All correctness checks passed: expected requests, tool dispatches, emitted/delivered events, and persisted/replayed row counts matched each workload.

## Signals to investigate

1. **ToolRegistry snapshot cost scales with catalog size.** Registering and snapshotting 1,000 production `ToolRegistry` entries took 9.12 ms p50 (13.14 ms p95); snapshot accounted for about 8.99 ms, while registration was about 0.16 ms. The projected provider schema was about 428 KB. The Engine-only 1,000-schema request fixture was much cheaper, so the next useful step is to profile the real snapshot path and measure actual catalog sizes, including MCP/connector discovery and repeated snapshots. Then test caching or reducing cloning only if the snapshot is repeated on real runs and correctness is preserved.

2. **SQLite transaction granularity is a strong lever.** Appending 500 envelopes in one `RunStore` batch took 1.93 ms p50; appending the same envelopes through 500 individual transactions took 20.89 ms p50, about 10.8× longer. Replay was similar in both cases. This is a controlled component comparison on a local temporary SQLite database. Measure production batch sizes and Host bridge call counts before changing write scheduling.

3. **Fan-out cost follows subscriber count and queued payload.** Publishing/draining 500 events to 10 subscribers took 8.57 ms p50, with 5,000 successful deliveries and zero drops. Under the delayed durable-consumer fixture, a 500-event queue exceeded the configured 8 KiB bound (164 KB high-water), invoked pause, and still retained all events. This identifies backpressure and queue memory as things to measure in the real HTTP/SSE path; the component fixture does not prove that production producers honor pause or that socket delivery has the same cost.

4. **Large prepared histories add measurable Engine request preparation, but current cost is modest.** The 100, 1,000, and 10,000-message fixtures took 0.062, 0.145, and 0.527 ms p50 respectively, with first-request-ready at 0.032, 0.097, and 0.417 ms. The 10,000-message fixture represents about 1.61 MB and an estimated 280K tokens, far beyond a normal provider context. Since histories are already assembled, transcript reads, prompt assembly, filtering, compaction, and restore remain unmeasured and are more important follow-up targets than optimizing this synthetic Engine loop.

5. **Same-process concurrency is fair in this scripted fixture, but does not characterize Worker scheduling.** Ten concurrent Engine runs reached about 3,150 runs/s with Jain fairness around 0.997 and p50 first-request-ready of 0.383 ms. This excludes process startup, IPC, DB bridge contention, and real provider waits; it is a control case for future Host/Worker measurements only.

6. **Tool-roundtrip work grows with the number of scripted tool operations.** Fifty calls plus their model turns took 2.10 ms p50 and executed the expected 51 requests and 50 dispatches. This measures Runtime orchestration around zero-cost tool implementations. Production executor queue wait, real command duration, output normalization, and failure/retry/cancel paths still need separate spans.

## Measurement correction

An early version included JSON serialization used to estimate payload bytes inside the large-history wall clock and reported about 13 ms for 10,000 messages. The timer now stops when `RunEngineImpl` completes; payload-size/token estimates happen afterward. The corrected Engine-only p50 is about 0.53 ms. Keep observer work outside measured latency in future fixtures as well.

## First TUI run

The separate TUI report is an in-process 80×24 terminal-stream run on the same development environment. It does not include terminal-emulator or PTY overhead.

- TUI construction/start to the first completed frame: p50 2.70 ms, p95 15.58 ms across 5 samples. The spread is a reminder that startup needs more repetitions before a threshold is useful.
- Input to painted frame on a prefilled transcript: p50 1.99 ms, p95 4.62 ms across 19 keystrokes; dispatch p95 was 0.37 ms. A typical input frame emitted 57 UTF-8 bytes, consistent with repainting changed cells instead of the whole screen.
- 80 streamed deltas at 4 ms spacing produced 6 frames and coalesced 74 deltas, with p50/p95 frame gap 69.4/69.8 ms, near the configured 70 ms throttle. The in-process output was 877 bytes. Compare final-content correctness and perceived smoothness while tuning the interval.
- Transcript `totalLines()` cold/warm was 33.0/2.8 ms for 2,000 blocks and 122.3/12.4 ms for 10,000 blocks. Warm passes had zero cache misses and hit every block. Cold layout is roughly proportional to transcript size; hot layout still scans block keys and merits attention only if real conversations reach this scale or the cost correlates with frame latency.

These are directional numbers with only five startup samples and one stream/layout pass per fixture. They establish the report shape, not an approved performance budget. The tap now records last output-write time and per-frame UTF-8 byte deltas; the prior baseline's cumulative character count had overstated individual frame sizes.

## Prioritized next measurements

1. Add per-process spans and correlated `runId` timing for the actual Host request path: accept/queue → fork or worker wake → worker ready → config/provider setup → durable transcript restore → context ready → first provider request → first event consumed → settled.
2. Complete the Worker↔Host DB bridge's message-write domains so a production Worker can run its normal durable transcript flow. Use a local scripted HTTP/SSE provider and a headless consumer; keep network/model wait as a separate span.
3. Record real tool catalog cardinality, snapshot frequency, provider schema bytes, and MCP/connector discovery cost. This validates whether finding 1 affects ordinary sessions.
4. Record production event batch sizes, SQLite transaction counts/latency, WAL growth, replay bytes, Host bridge calls, subscriber count, slow-consumer queue high-water, pauses, reconnects, and delivered sequence gaps.
5. Run independent Workers at 1/4/10/25 concurrent runs; report per-run p50/p95/max, throughput, fairness, queue depth, CPU, RSS, event-loop delay, startup vs warm reuse, and correctness under cancellation/retry.
6. Add real context preparation and transcript scale cases: cold restore, warm cache, long conversation, tool-heavy transcript, compaction, and prompt assembly. Report messages/bytes read and scanned, tokens before/after, time by phase, and heap/GC pressure.
7. Add executor-specific measurements for command/file/search/browser/MCP tools with queue wait, runtime, output bytes, retries, cancellation latency, and cleanup cost. Compare equivalent deterministic fixtures before using live workloads as trend evidence.

Do not set CI thresholds from this first run. First repeat the same fixtures on a quiet machine, check run-to-run spread, then correlate candidate proxy metrics (catalog snapshot duration, DB transactions per run, event bytes/deliveries, context bytes scanned) with real Host/Worker wall-clock spans. Promote only repeatable, correctness-preserving correlations into regression gates.
