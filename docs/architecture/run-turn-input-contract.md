# Run turn input contract

What a caller of `POST /v1/agent-runs/start` may ask for, what the Host
decides, and where each value ends up. This is the contract T23 task 2 (the
Desktop adapter) and the TUI/model owners build against.

Nothing here changes the Desktop entry point. The Desktop adapter adopts the
contract; the Host already enforces it.

## The two layers

| Layer | Who writes it | What it means |
| --- | --- | --- |
| Typed fields on `StartAgentRunInput` | the caller | a REQUEST. The Host validates it and may narrow it. |
| `options` bag | the caller | anything the protocol has no field for. The Host strips the keys it decides and fills them itself. |

A bag that named a Host-decided field would be a second authority for it, so
the Host removes those keys and substitutes its own values. The stripped keys
are `permissionMode`, `permissionModeOverride`, `agentProfileId`, `modes`,
`tools`, `permissionRules`, `hostSwitch`.

## Fields

| Field | Type | Meaning | Host may narrow it? |
| --- | --- | --- | --- |
| `permissionMode` | `default \| acceptEdits \| plan \| bypassPermissions \| dontAsk` | the mode the caller asks this turn to run under | yes — to the parent's ceiling |
| `effort` | `low \| medium \| high \| max` (+ model tiers) | the reasoning effort for THIS turn | no |
| `agentProfileId` | `string \| null` | the agent profile; `null` means "no profile" | no |
| `attachments` | `FileAttachment[]` | the files the user attached | no |
| `modes` / `tools` | `string[]` | what the turn declares it runs under | no (recorded on the manifest) |
| `permissionRules` | wire record | the turn's rule table | no (recorded on the manifest) |

`permissionMode` is the PROTOCOL's vocabulary. The agent's own vocabulary is
narrower (`default \| auto \| bypassPermissions`) and the two are not
interchangeable: `acceptEdits` has no exact agent-space equivalent, and
substituting `auto` for it would silently widen the turn's authority. The Host
records the protocol value; the worker applies the agent one.

## Where each value ends up

| Field | Manifest | Worker | Provider / tool input |
| --- | --- | --- | --- |
| `permissionMode` | `permissionPolicy.mode` | reaches the worker; applying it is the worker's seam (below) | — |
| `effort` | `agent.effort` | `options.effort` | `thinking.budget_tokens` on the Anthropic request |
| `agentProfileId` | `capabilities.profiles` | `options.agentProfileId` | — |
| `attachments` | named by reference in the run input | `options.files` | the attachment context message in the provider's messages |
| `modes` / `tools` | `capabilities.modes` / `capabilities.tools` | — | — |
| `permissionRules` | `permissionPolicy.rules` | — | — |

## Rejection

An input the Host cannot honour is refused, never repaired:

- a malformed typed field is a `400` at the HTTP boundary;
- a well-formed but unrunnable value is a start that ends at
  `refused_invalid_input`, with the offending field named.

Nothing degrades to a default. A turn that ran under `default` after the
caller asked for `acceptEdits` would look like the feature working.

## Parent and child

A delegated run (its caller is a run) and a spawned session (its
`parent_session_id` is a session) both hold the turn to a permission-mode
ceiling. The tightest of the two applies: a child may narrow, never widen.
`maxTurns` keeps its existing minimum rule.

## Attachments

Attachments travel in the existing carrier — `options.files`, the same field
the legacy path uses — and reach the model through the existing attachment
context (`[System Parsed File]`), which is how the Desktop's attachments
already reach the model today. The run input names them BY REFERENCE: the
snapshot carries a digest and a locator, never the payloads, and the turn's
digest names the attachment ids.

No new file-access channel is opened, and no attachment is read from a path
the Host did not receive.

## Seam request — `packages/host/src/worker-process-entry.ts`

The Host's permission mode now reaches the worker, but the worker still
decides the agent's mode from the session row and the agent-space override:

```ts
resolveChatStartAgentMode({ rowProfile, optionOverride: msg.options?.permissionModeOverride })
```

Two changes are needed there, and both are in the worker's lane:

1. read the HOST's adjudicated mode — `msg.manifest.permissionPolicy.mode`
   (the headless path already does this: `worker-headless-run-host.ts`) —
   instead of deriving it from the row;
2. apply it to the agent, instead of passing the agent-space
   `permissionModeOverride` through.

Until that happens, the mode is recorded correctly and carried correctly, and
the agent still runs under the mode the session row says.

`input.options.permissionMode` in the run input snapshot is the same value:
it is currently the agent-space mode the worker derived, and it becomes the
Host's protocol-space value once the seam above is taken.
