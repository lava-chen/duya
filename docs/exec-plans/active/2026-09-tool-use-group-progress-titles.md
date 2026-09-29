# Tool-use group progress titles

**Status:** Implementation complete; live Electron/provider smoke pending
**Created:** 2026-09-29

## Goal

Show a short, user-visible description of the work represented by a group of
tool calls in the chat's tool-use toggle row. Use provider commentary when it is
available, provide a provider-neutral progress update path, and retain a safe
deterministic fallback for providers or models that produce no progress title.

The title describes intended work. It is not a thinking/reasoning summary, and
must not expose hidden reasoning.

## Background

Providers differ in how they represent text emitted around tool calls. Some APIs
have a structured commentary phase, some can emit ordinary assistant text next
to tool calls, and some recommend a dedicated update function instead of
requiring pre-tool text. A provider-neutral UI cannot assume that commentary
exists or that ordinary assistant text has progress semantics.

The UI may also already have per-tool labels (for example, a tool name or a
short action label). Those labels describe individual calls; this plan adds a
group-level title and preserves the per-tool labels inside the group.

## Design decisions

1. Normalize progress into an explicit internal event, conceptually:

   ```ts
   type ToolGroupProgress = {
     title: string;
     source: 'provider_commentary' | 'model_progress_tool' | 'tool_fallback';
   };
   ```

   Reuse an existing event envelope if one already serves this purpose; do not
   add a parallel transport without first checking the current stream contract.

2. Resolve titles in this order:

   - Structured provider commentary explicitly marked as user-visible progress.
   - A private `progress_update({ title })` control call for providers without
     suitable commentary support. Intercept it in the agent harness; never run
     it as a normal tool or show it as a user-actionable tool call.
   - A deterministic fallback based on existing tool labels and safe,
     allowlisted input fields. Use a generic label when no useful safe summary
     can be made.

3. Do not treat arbitrary assistant text, `thinking`, reasoning blocks, or
   reasoning summaries as group titles. Do not surface raw chain-of-thought.

4. A progress update creates a stable group identity for subsequent tool calls
   in the same agent turn. Capture that group identity on each tool call when
   the call is emitted, and keep it on the call's transcript/action record.
   Tool results, progress, approval, retry, and cancellation updates remain
   attached to their originating call and therefore to its original group,
   even if a later title has started another group or results finish out of
   order. A later title affects only calls emitted after it; it does not close,
   move, or otherwise mutate a group that still has active calls. Discard an
   update that is never followed by a tool call. Keep each call's existing
   label, input, result, status, and approval actions intact within its group.

5. Sanitize titles before display: trim whitespace, reject empty/control-only
   values, cap length, and avoid rendering untrusted markup. Never derive a
   title from secrets, arbitrary command output, or unrestricted argument
   serialization.

## Scope

- Provider adapters and stream normalization for commentary/progress events.
- Agent-side handling of the private progress control call.
- Prompt guidance that asks for concise, factual task labels without asking for
  hidden reasoning.
- Tool-use group state and rendering in the chat transcript.
- Focused unit and UI verification for provider normalization, grouping, and
  fallback behavior.

Out of scope: exposing thinking/reasoning summaries, changing individual tool
execution semantics, or requiring every provider/model to emit commentary.

## Implementation plan

### Phase 1: Map the current event and UI flow

- [x] Read the current active-plan index and architecture notes; identify
      overlap with provider, tool-catalog, streaming, and transcript plans.
- [x] Trace provider SDK events through normalization, Agent Server/SSE, IPC,
      message persistence, and the renderer's tool-use group.
- [x] Record which configured providers expose a distinct user-visible
      commentary field, which only expose ordinary text, and which need the
      progress control call. Confirm each against the adapters in this repo.
- [x] Locate existing per-tool semantic labels and define how group titles
      relate to them without replacing them.

### Phase 2: Add a canonical progress event

- [x] Define or extend the typed stream event for tool-group progress, carrying
      title and source; preserve it across every transport boundary it crosses.
- [x] Normalize only explicitly user-visible provider commentary. Keep normal
      assistant response text and reasoning data on their existing paths.
- [x] Add the private progress control call to supported model tool schemas and
      intercept it before ordinary tool resolution, approval, execution, and
      tool-result persistence.
- [x] Add prompt guidance: emit one brief title before a purposeful batch when
      possible; do not narrate every tool or reveal hidden reasoning.
- [x] Define title validation, truncation, replacement, and empty-title rules.

### Phase 3: Group tool calls by progress title

- [x] Extend the existing tool-group reducer/state so progress starts the next
      stable group identity. Assign membership when a tool call is emitted;
      don't infer it from result arrival order or only from adjacency in the
      rendered action list.
- [x] Ignore orphan progress updates and preserve current grouping behavior
      when no progress event arrives.
- [x] Key the group header and its expanded/collapsed state by stable group ID;
      keep independent groups independent when earlier calls remain active.
- [x] Render the group title in the toggle row while preserving each tool's
      current semantic label and its normal running, result, error, and approval
      presentation.
- [x] Handle parallel tool calls, streaming updates, cancellation, retries,
      approval pauses, and late/out-of-order results without losing or
      reordering events.

### Phase 4: Deterministic fallback

- [x] Use existing safe tool display labels as the first fallback source.
- [x] Add bounded, allowlisted summaries for tools whose inputs provide a clear
      action (for example, a search query or file operation); do not serialize
      complete arguments or outputs.
- [x] Fall back to a generic localized title when no safe, useful summary is
      available. Keep the source as `tool_fallback` for diagnostics.
- [x] For fallback-only turns, derive one deterministic title per group from
      its safe tool labels; do not merge unrelated groups merely because a
      previous tool is still running.

### Phase 5: Verification and rollout

- [x] Add unit coverage for provider event normalization, progress-control
      interception, title validation, grouping boundaries, orphan updates, and
      fallback behavior.
- [x] Verify that progress control calls never reach normal tool execution,
      approvals, persisted tool results, or user-visible per-tool rows.
- [x] Run focused provider/stream and renderer tests, then the relevant
      typechecks.
- [ ] Verify the live chat UI in Electron for a supported commentary provider,
      a provider using the progress control call, and a fallback-only provider.
- [x] Update `ARCHITECTURE.md` if the canonical event or transport contract
      changes; update this plan's checkboxes and the active-plan index as work
      proceeds.

## Acceptance criteria

- A supported structured commentary event can title the next tool-use group.
- A provider without commentary can produce the same UI through the intercepted
  progress control call.
- Providers/models that produce neither still show a useful safe fallback.
- Thinking and reasoning content never becomes a group title.
- Group titles do not remove or alter per-tool labels, approval actions,
  results, errors, or cancellation states.
- Empty, orphaned, oversized, or unsafe titles fail closed to existing behavior
  or the generic fallback.
- The UI remains correct when tool calls execute concurrently or finish out of
  order; every update stays within the group identity captured when its tool
  call was emitted.


## Implementation status (2026-09-29)

The implementation and focused verification are complete. OpenAI Responses maps
only explicitly marked commentary output to a progress title; regular assistant
text and reasoning remain unchanged. Other adapters in this repository do not
expose a separate commentary field, so they use the private intercepted
`progress_update` path or deterministic fallback.

The private control call is intercepted inside the agent and retained only in
the working model request context. It does not reach normal tool execution,
approval, durable tool-result persistence, or renderer action rows. Stable
group IDs and source metadata travel with tool events so late results stay
attached to their original group.

Focused provider, agent, stream, grouping, and renderer tests passed.
`npm run typecheck:all` passed. A Playwright browser harness rendered the actual
chat components in light and dark themes. Live Electron round-trips against
configured providers have not been run, so the plan remains active until that
final smoke verification is available.
