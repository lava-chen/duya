# 25 — Wave 3 Plugin App Host-to-worker invocation

2026-10-19. This is a bounded T31 continuation after the T31a bridge kernel and T31b durable instance API. It adds a real Host-owned command caller into the session worker; it does not claim that Desktop has launched an iframe. T31/T32 remain open until a renderer/Main boundary validates the real iframe and a two-App/two-instance sample is exercised.

## Ownership and scope

This lane owns a new agent-protocol invocation contract, new Host invocation/binding modules, the authenticated local invocation route and typed Host client, the Host worker command dispatch and worker-side executor adapter, focused tests, and this plan. It may extend `packages/host/src/run-execution.ts` after the `7f1fca1b` worker attempt-fence prerequisite; integration must preserve its current session/run/epoch authority. It does not edit `packages/ui`, Desktop Extensions UI, Web client, or the shared renderer branch.

## Contracts

The renderer/Main boundary will eventually verify `event.source === iframe.contentWindow`, the expected (possibly opaque `null`) origin, and a Host-issued launch nonce. That proof is not representable across Host HTTP or the worker process boundary, so the worker must never fabricate a DOM `source` or claim it checked origin. The new worker entry is a trusted Host command only. Keep the existing DOM-facing bridge method strict; use a separately named Host-authenticated adapter for this internal worker command.

The renderer/Main boundary will call the typed Host client; only trusted Main launch/bind code may provide an installed App selector and session selector. The local route is registered behind the existing bearer-token and Origin checks. Bind inputs never include run/epoch/grants/manifest/connector identity. Invoke inputs contain only Host-issued `bindingId`/nonce, `toolId`, JSON `arguments`, and an optional request ID. Host validates the requested plugin/App/instance against an explicitly injected trusted manifest resolver and the durable instance store, checks status and schema version, resolves an active session run and current epoch from RunExecution, checks Host grants, then mints the worker command with session/run/epoch and a one-use invocation ID. Run/session/epoch/capabilities are derived by Host, not copied from the iframe. Stale attempts, revoked/disabled instances, missing grants, manifest mismatch, and absent workers fail closed. With the default standalone composition lacking trusted manifest/grant/capability resolvers, bind/invoke explicitly report unavailable; they must not infer authority.

The worker accepts the command only over its Host stdin protocol. It resolves exactly one MCP descriptor from the active worker catalog generation, retains that generation's connection/executor, uses the canonical input schema and revision for validation, and executes through the existing Runtime `createMCPToolExecutor` authorization path with a fresh `ToolUseContext` whose `requestPermission` is the current Host approval callback. It must not construct an unguarded connector call. A Host-authoritative binding check runs before execution and again after any permission await at the final side-effect seam; `true` cannot be cached across the approval wait.

## Known authority gap to resolve explicitly

`PluginAppDefinition.requiredCapabilities` is metadata such as `mcp:dashboard.read`, but current `MCPToolDefinition` only has MCP server/tool identity and source; there is no canonical mapping from a tool to an App capability ID. The durable instance record deliberately stores no grants. The standalone Host has no composed grant authority today. `plugin-core`'s in-memory `PermissionService` is an audit-only install ledger: recording there is explicitly not proof of user approval, so it cannot be used as a grant source. Runtime authority remains `decideMcpSource` plus the existing `requestPermission` flow. Do not equate a manifest request with a grant or infer a capability ID from a server/tool name. Add explicit Host grant and descriptor-capability resolver contracts and fail closed when either is absent. A real Desktop-owned authority source and its injection into Host remain a named integration requirement.

## Implementation sequence

1. Define strict Host-to-worker command/result and Host binding API contracts, plus the narrow authenticated `/v1/local/plugin-app-invocations` route and typed Host client. Host creates, revokes, and consumes bindings; invoke callers cannot choose session/run/epoch/granted capabilities or connector identity.
2. Add Host composition ports for trusted manifest resolution, Host grant resolution, current attempt lookup, and worker dispatch. Validate that the trusted manifest has the exact app definition and state schema version recorded on the instance; validate active attempt and grants immediately before dispatch.
3. Add a worker command handler tied to a live run, the active MCP catalog revision, canonical schema, and existing executor/approval ports. Reject duplicate or unknown tool IDs and malformed/oversized/non-JSON arguments. Re-query Host binding validity after approval before the connector side effect.
4. Add attempt-fenced request/reply correlation so worker results cannot resolve another binding or run. Revocation and run settlement remove the Host binding and cause an in-flight post-approval check to reject.
5. Add focused tests for the actual Host→worker command path: deny approval means zero connector calls; allow means exactly one; forged authority fields, unavailable grant source, wrong instance/plugin/App/schema, missing tool/schema, stale epoch, and revocation during approval mean zero calls. Keep the existing strict DOM source/origin kernel tests green.

## First production acceptance test and completion boundary

A Host/worker integration fixture must create a real durable instance and trusted App manifest, start a real worker session/run, capture a descriptor from its live MCP registry, and invoke through the Host command API. Use the production MCP executor and Host PermissionRequest round-trip. Prove deny=0, allow=1, and stale attempt/revocation after approval=0 side effects. This closes the Host-to-worker backend caller only. Full T31 requires an Electron iframe→Main source/origin/nonce check and a narrow Main→Host authenticated adapter. T32 requires two App IDs, two independent durable instances, restart persistence, and isolation tests. Neither is marked complete by this plan's backend slice.

## Closeout 2026-10-19 — backend slice verified, T31/T32 still open

### What the closeout changed

The inherited implementation was kept. Two real defects were found while
reviewing it and fixed:

1. **Plugin-owned MCP tools never reached the Host.** The worker catalog
   reports a plugin-owned MCP server as `source.kind === 'plugin'` and a
   bundled one as `'mcp'` (`sourceForTool` in
   `packages/agent-runtime/src/tools/catalog/registry.ts`). The worker's
   `describePluginAppMcpTools` filter accepted only `'mcp'`, so a Plugin App
   — whose tools are plugin-owned by definition — always got an empty
   descriptor list and could never bind a tool. `invokePluginAppMcpTool`
   carried the same filter. Both now use `isMcpCatalogEntry`, which requires
   real MCP identity (`definition.mcpInfo`) and a `mcp`/`plugin` catalog
   source. Host-side `resolveToolCapability` plus the grant check still
   decide which of the described tools a binding may use.
2. **A revoked binding was reported as a user denial.** The Runtime's
   `beforeInvoke` failure and a user "deny" both produced an error result,
   and the worker mapped both to `tool_denied`. The Runtime gate now tags
   the revoked case with `metadata.reason === 'authority_revoked'`, and the
   worker maps it to `binding_revoked`, so the Host can tell an approval
   refusal apart from an authority loss.

`createExecutorPorts` in
`packages/host/src/connector-services/worker-permission-binding.ts` is now
exported as `createWorkerMCPExecutorPorts` so the integration fixture uses
the production executor wiring rather than a copy of it.

Two liveness defects in the inherited Host→worker command path were fixed
as well:

3. **The Host deadline was shorter than the approval window.** The worker
   command timed out after 30 s, but the Runtime's MCP approval card stays
   valid for five minutes, so a user who took longer than 30 s to answer
   made the Host report `504 plugin_app_worker_timeout` while the worker
   went on to run the side effect. The invoke deadline is now 330 s and the
   catalog-inspection deadline stays at 30 s.
4. **A dead worker left the caller hanging.** A pending plugin-app command
   was only released by its own timeout. The controller now listens for the
   worker's `exit` and rejects the pending command with
   `409 worker_unavailable`.

Expired bindings are also swept when a new binding is minted, so an
App that binds and never invokes cannot grow the table without bound.

### Evidence

- `packages/host/tests/plugin-app-invocation-worker.test.ts` (new, 8 cases)
  drives a real `WorkerSession` with a real `ToolRegistry`, a real Runtime
  MCP executor built by `createMCPToolExecutor`, the production executor
  ports, the production `WorkerPermissionRequests` broker over a real
  `PermissionLedger` SQLite table, and the production
  `createHostPluginAppInvocationApi`. The connector is a controlled
  counter. It proves: plugin-owned tools are described; approve → exactly
  one connector call; deny → zero; grant revoked during the approval wait
  → zero; canonical mapping flipped during the approval wait → zero; epoch
  moved during the approval wait → zero; instance no longer active → zero;
  capability outside the manifest → zero.
- Reverting fix (1) alone turns 6 of those 8 cases red, so the fixture
  binds to the defect rather than to a tautology.
- `npm run typecheck:all` passes.
- `packages/agent-runtime/tests/mcp-executor.test.ts` 11/11,
  `packages/host/tests/run-execution.test.ts` 12/12,
  `packages/host/tests/plugin-app-invocation-http.test.ts` 2/2,
  `packages/host/tests/plugin-app-bridge.test.ts` 24/24.

### Still open — T31 and T32 are not complete

1. **Desktop-owned trusted resolver injection.** `StartLocalHostOptions.pluginAppInvocationAuthority`
   exists but nothing in `apps/desktop` supplies it, so the standalone Host
   answers `503 plugin_app_invocation_authority_unavailable` for every bind.
   A Desktop authority source must own installed-manifest resolution, the
   grant ledger, and the canonical descriptor→capability mapping.
2. **iframe → Main boundary.** No renderer/Main code verifies
   `event.source === iframe.contentWindow`, the expected origin, and a
   Host-issued launch nonce, and no narrow Main→Host authenticated adapter
   exists. The worker never fabricates a DOM source or claims an origin
   check; that proof is still owed at the Electron boundary.
3. **Two App / two instance sample.** No fixture with two App IDs, two
   independent durable instances, restart persistence, and cross-instance
   isolation exists yet.
4. **Cross-process TOCTOU window.** `beforeInvoke` is the last check and
   sits directly in front of the generation-captured
   `scopedClient.callTool`, but the check itself is a round trip to the
   Host. A grant revoked in the instant between the Host answering "current"
   and the connector call still lets the call through. Closing that window
   would need a Host-side capability token that the connector itself
   verifies; it is not solvable inside the current check-then-call shape.
5. **Diagnostic gaps.** A failed `plugin-app:describe-tools` is flattened to
   an empty descriptor list, so "no live run" and "no authorized tools" are
   indistinguishable. The stub-worker fixture in
   `packages/host/tests/run-execution.test.ts` also uses a synthetic tool id
   (`mcp:server/dashboard.read`) that no real catalog produces.
6. **No real MCP protocol end to end.** The connector is a controlled
   counter behind the real executor; a real MCP server round trip through
   `MCPManager` is still unproven for this path.

