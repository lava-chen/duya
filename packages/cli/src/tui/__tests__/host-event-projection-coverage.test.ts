/**
 * Census of what the TUI projector DROPS.
 *
 * ## The finding
 *
 * `projectHostEvent` (`host-event-stream.ts:24`) has 15 `case` arms and one
 * `default: return null`. The protocol declares **44** message types, of which
 * **38** are `RunEvent`s the projector is typed to receive — so **23 events
 * reach the TUI and are dropped without a word.**
 *
 * D9.5 found one of those 23 (`permission.resolved`) by accident, while chasing
 * a different defect. That it was the only one found is itself the finding: a
 * `default: return null` with no inventory is not a decision, it is an absence.
 * Nobody can tell, reading the projector, whether an event is dropped because
 * the TUI deliberately has no frame for it or because nobody thought about it.
 *
 * ## What is actually produced and dropped
 *
 * These are not declarations with no producers. `tool.arguments_delta` is
 * published straight from `run-engine.ts:1320`; the whole `compaction.*` family
 * from `packages/agent-runtime/src/engine/compaction.ts`;
 * `assistant.mode_changed` / `assistant.goal_updated` / `turn.retry_scheduled`
 * / `hook.invoked` from `chat-event-translator.ts`. Every one of those events
 * is minted by the engine leg that production actually runs.
 *
 * ## What this test does and does not claim
 *
 * It does NOT claim every event should be projected — most of these have no
 * sensible TUI frame, and inventing one would be worse than dropping it. It
 * claims the drop is **declared**: every unprojected type appears in
 * `DECLARED_UNPROJECTED` with a reason, and the set matches exactly, in both
 * directions. A new event type added to the protocol turns this red and forces
 * someone to write that sentence.
 *
 * `SUSPICIOUS` entries are the ones worth a product decision. They are called
 * out by name at the bottom so they cannot quietly age into "intentional".
 *
 * @see docs/exec-plans/active/610-architecture-series/20-three-surface-bug-sweep.md
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EVENT_TYPES } from '@duya/agent-protocol';

const PROJECTOR_SOURCE = fileURLToPath(new URL('../host-event-stream.ts', import.meta.url));

/**
 * The message types that are NOT `RunEvent`s.
 *
 * `run.start` / `run.cancel` / `run.pause` / `run.resume` / `permission.respond`
 * / `permission.setMode` are INBOUND control-plane commands — the host asks
 * the runtime to do something. `projectHostEvent` is typed `RunEvent -> …`, so
 * they can never arrive here. They are listed so the subtraction below is
 * visible rather than a magic filter.
 */
const CONTROL_PLANE_MESSAGES = [
    'run.start',
    'run.cancel',
    'run.pause',
    'run.resume',
    'permission.respond',
    'permission.setMode',
] as const;

/**
 * Every `RunEvent` the projector does NOT turn into a frame, with the reason.
 *
 * `suspicious: true` means "there is a producer and a user could reasonably
 * expect to see this" — not "this is a bug". The distinction is the whole
 * point of the list.
 */
const DECLARED_UNPROJECTED: Record<string, { reason: string; suspicious?: true }> = {
    'run.started': { reason: 'The TUI is opened by this run; there is no earlier screen state for it to update.' },
    'run.paused': { reason: 'No pause surface exists in the TUI; a paused run renders like a quiet one.' },
    'turn.completed': { reason: 'Turn boundaries are already visible from `turn.started` and the next delta.' },
    'assistant.message_finalized': { reason: 'Durable model output; the deltas and the text block already painted it.' },

    // ── suspicious: producers exist and a user would expect to see these ──
    'assistant.mode_changed': {
        reason: 'Minted by `chat-event-translator.ts:366`. The TUI has a mode selector in its composer, so a mode changed BY THE MODEL leaves that control stale.',
        suspicious: true,
    },
    'assistant.goal_updated': {
        reason: 'Minted by `chat-event-translator.ts:378`. The goal tracker is a user-visible surface elsewhere; here it updates silently.',
        suspicious: true,
    },
    'compaction.started': {
        reason: 'Minted by `engine/compaction.ts:208`. Compaction DISCARDS conversation history, and the TUI says nothing while it happens.',
        suspicious: true,
    },
    'compaction.completed': {
        reason: 'Minted by `engine/compaction.ts:271`. The frame that tells the user why older turns vanished.',
        suspicious: true,
    },
    'compaction.failed': {
        reason: 'Minted by `engine/compaction.ts:293`. A failed compaction is a failure the user is never shown.',
        suspicious: true,
    },
    'compaction.over_threshold': {
        reason: 'Minted by `engine/compaction.ts:229`. The warning that precedes an automatic history drop.',
        suspicious: true,
    },
    'compaction.step': { reason: 'Per-step progress inside one compaction; too chatty for a transcript line.' },
    'turn.retry_scheduled': {
        reason: 'Minted by `chat-event-translator.ts:356`. A provider retry looks identical to a stall, so the wait reads as a hang.',
        suspicious: true,
    },
    'tool.arguments_delta': {
        reason: 'Minted by `run-engine.ts:1320`. Argument streaming is dropped, but `tool.call_preview` delivers the complete arguments, so nothing is lost — only the progressive fill.',
    },
    'tool.timed_out': {
        reason: 'Minted by `#dispatchCall` on a refused call. D9: it is a protocol-illegal orphan (no matching `tool.call_started`) and is REFUSED by the ledger before it can reach any consumer, projector included.',
        suspicious: true,
    },
    'permission.resolved': {
        reason: 'D9.5: a denied call leaves no trace in the transcript because the resolution never reaches the ledger AND the projector has no arm for it. Both layers are broken on this one event.',
        suspicious: true,
    },
    'permission.expired': {
        reason: 'No expiry timer emits it yet (declared but unwired in the control-plane census), so there is nothing to project.',
    },
    'checkpoint.saved': { reason: 'Durable state for resume; it has no transcript meaning.' },
    'hook.invoked': { reason: 'Hook telemetry; the caller already surfaces hook output as messages.' },
    'diagnostic': {
        reason: 'The structured-log channel: a dedicated stream an evaluator consumes, deliberately not the product UI. The TUI renders the transcript, not the log.',
    },
    'diagnostic.trace': { reason: 'Debug tracing, deliberately not user-facing.' },
    'extension.custom': {
        reason: 'The forward-compatibility namespace. The protocol contract says unknown namespaces MUST be ignored, so `default: return null` IS the specified behaviour here.',
    },
};

/** The `case` arms the projector actually has, read from its own source. */
function projectedEventTypes(): Set<string> {
    const source = readFileSync(PROJECTOR_SOURCE, 'utf8');
    return new Set([...source.matchAll(/case '([a-z_.]+)':/g)].map((m) => m[1] as string));
}

describe('what the TUI projector drops', () => {
    const projected = projectedEventTypes();
    const runEvents = EVENT_TYPES.filter((t) => !(CONTROL_PLANE_MESSAGES as readonly string[]).includes(t));
    const unprojected = runEvents.filter((t) => !projected.has(t));

    it('reads the projector arms out of its source, and finds a plausible number', () => {
        // The census below is only as good as this extraction. If the `case`
        // arms were ever written as a computed label, `projected` would go
        // empty and every event would read as "unprojected" — the list would
        // then match by accident. This pins the extraction against that.
        expect(projected.size).toBeGreaterThanOrEqual(15);
        expect(projected).toContain('assistant.text_delta');
        expect(projected).toContain('run.completed');
    });

    it('every unprojected RunEvent is DECLARED, with a reason', () => {
        // Exact, both directions. Extra keys would let a declared entry rot
        // after its event gains a projector arm; missing keys are the defect
        // this file exists to surface.
        expect(unprojected.slice().sort()).toEqual(Object.keys(DECLARED_UNPROJECTED).sort());
    });

    it('every declaration explains itself', () => {
        for (const [type, entry] of Object.entries(DECLARED_UNPROJECTED)) {
            expect(entry.reason.trim().length, `${type} has no reason`).toBeGreaterThan(20);
        }
    });

    it('names the suspicious ones, so they cannot quietly become "intentional"', () => {
        // Not a behavioural assertion — a reading aid promoted to a test. If a
        // `suspicious` entry is resolved, it should lose the flag with a reason
        // that says what was decided, and this list gets one item shorter.
        const suspicious = Object.entries(DECLARED_UNPROJECTED)
            .filter(([, entry]) => entry.suspicious === true)
            .map(([type]) => type);

        // eslint-disable-next-line no-console -- a census should be readable
        console.log('[census] TUI drops these produced events:', suspicious.join(', '));
        expect(suspicious.length).toBeGreaterThan(0);
    });
});
