/**
 * `/effort` — choose the reasoning effort the next turns run at.
 *
 * ## Why the CLI needs this at all
 *
 * pi puts thinking level on the composer border (`getThinkingBorderColor`) and
 * on a cycle key, because it is the one setting that changes what the next
 * message costs without changing the conversation. duya's Desktop has the same
 * control per message (`low | medium | high | max`, see `CronEditorModal`'s
 * effort options); the CLI had no equivalent, so a model's reasoning budget was
 * whatever the worker defaulted to and the user had no way to see it — let
 * alone change it.
 *
 * ## Where the options come from
 *
 * `ProviderModelCapabilityRecord.reasoningEffortOptions` is the authoritative
 * per-model list, written by the Desktop provider editor and by the models API.
 * When it is absent the four levels the Desktop offers are used, and `auto` is
 * always first: "let the model decide" is a real choice, and it is the default.
 *
 * The choice is persisted (`cli.tui.effort`) rather than kept in memory, so the
 * border colour after a restart describes the same appetite the user last set.
 *
 * ## Global, with per-model exceptions
 *
 * This command sets the GLOBAL default. A model that deserves its own level
 * gets one through the `Effort · <model>` row in `/settings`, which writes
 * `cli.tui.effortByModel` and wins for that model alone — the reason the notice
 * printed here names the override when one exists: without that sentence, a
 * global change that leaves the border untouched reads as a bug.
 */

import { EFFORT_LABELS, EFFORT_LEVELS, normalizeEffort, type EffortLevel } from '../theme.js';
import { effortForModel, parseTuiPreferences } from '../preferences.js';
import type { TuiChoice } from '../TUIApp.js';
import type { TuiSlashCommandDef, TuiSlashContext, TuiSlashOutcome } from './types.js';

/** The levels the Desktop's per-message selector offers, used when a model is silent. */
const DEFAULT_MODEL_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'max'];

/**
 * Levels this model accepts, `auto` first.
 *
 * Capability rows are per model, so the list changes when the model does — the
 * reason this is resolved per invocation rather than cached at module load.
 */
async function optionsFor(ctx: TuiSlashContext): Promise<EffortLevel[]> {
  let declared: readonly string[] = [];
  try {
    const capability = await ctx.client.getProviderModelCapability(ctx.session.providerId, ctx.session.model);
    declared = capability?.reasoningEffortOptions ?? [];
  } catch {
    // A capability read is advisory: the picker must still open when the Host
    // cannot answer, otherwise a provider hiccup looks like "no effort control".
  }
  const declaredLevels = declared
    .map((value) => normalizeEffort(value))
    .filter((level) => level !== 'auto');
  const levels = declaredLevels.length > 0
    ? [...new Set(declaredLevels)]
    : DEFAULT_MODEL_EFFORTS.map((value) => normalizeEffort(value));
  return ['auto', ...levels.filter((level) => level !== 'auto')];
}

/**
 * What is in force for the model in front of the user.
 *
 * Two answers, not one: `effective` decides which row is marked `current` and
 * which colour the border already is, while `override` is what makes a global
 * change invisible for this model. Reading only the global key here would mark
 * the wrong row the moment a per-model default exists.
 */
async function currentLevel(ctx: TuiSlashContext): Promise<{ effective: EffortLevel; override: EffortLevel | null }> {
  try {
    const preferences = parseTuiPreferences(await ctx.client.getSettings());
    const override = preferences.effortByModel[ctx.session.model ?? ''];
    return {
      effective: effortForModel(preferences, ctx.session.model),
      override: override === undefined || override === 'auto' ? null : override,
    };
  } catch {
    return { effective: 'auto', override: null };
  }
}

function describe(level: EffortLevel, current: EffortLevel): TuiChoice {
  return {
    label: EFFORT_LABELS[level],
    value: level,
    ...(level === current ? { description: 'current' } : {}),
  };
}

function outcomeFor(level: EffortLevel): TuiSlashOutcome {
  return { kind: 'effort_changed', effort: level === 'auto' ? null : level };
}

/**
 * The line printed after a change, which has to be honest about the one case
 * where nothing visibly moves: this model has its own default, so a global
 * change repaints neither the border nor the footer suffix.
 */
function announce(level: EffortLevel, model: string, override: EffortLevel | null): string {
  const base = `Reasoning effort: ${EFFORT_LABELS[level]} (applies to the next turn).`;
  if (override === null || override === level) return base;
  return `${base} ${model} keeps its own default (${EFFORT_LABELS[override]}) — clear it on the "Effort · ${model}" row in /settings.`;
}

const EFFORT_COMMAND: TuiSlashCommandDef = {
  name: 'effort',
  argsHint: '[level]',
  description: 'Set reasoning effort for the next turns',
  group: 'Model',
  async run(ctx: TuiSlashContext, args: string): Promise<TuiSlashOutcome> {
    const supported = await optionsFor(ctx);
    const { effective, override } = await currentLevel(ctx);
    const model = ctx.session.model ?? '';
    const query = args.trim().toLowerCase();

    if (query !== '') {
      const requested = normalizeEffort(query);
      // Validated on the RAW token, not on the normalized level: `normalize`
      // maps anything unknown to `auto`, so checking the normalized value
      // would accept `turbo` and silently mean auto.
      const isAuto = query === 'auto' || query === 'off' || query === 'default';
      const known = isAuto || supported.some((level) => level === query);
      if (!known) {
        ctx.tui.printError(
          `Unknown effort "${args.trim()}". Available: ${supported.join(', ')}.`,
        );
        return { kind: 'handled' };
      }
      ctx.tui.printNotice(announce(requested, model, override));
      return outcomeFor(requested);
    }

    const picked = await ctx.tui.choose(
      `Reasoning effort · ${model}`,
      supported.map((level) => describe(level, effective)),
    );
    if (picked === null) return { kind: 'handled' };
    const level = normalizeEffort(picked);
    ctx.tui.printNotice(announce(level, model, override));
    return outcomeFor(level);
  },
};

/**
 * `/thinking` — pi's name for the same switch.
 *
 * duya calls it effort because that is what the Desktop's per-message control
 * calls it and what the wire field is called; pi calls it thinking. The level
 * is the same ladder either way, so this is the same command under the name a
 * pi user's fingers already know — an alias, not a second concept.
 */
const THINKING_COMMAND: TuiSlashCommandDef = {
  ...EFFORT_COMMAND,
  name: 'thinking',
  description: 'Set the thinking level (alias of /effort)',
};

export const EFFORT_COMMANDS: readonly TuiSlashCommandDef[] = [EFFORT_COMMAND, THINKING_COMMAND];

/** All levels, for tests and for callers that want to validate a value. */
export const KNOWN_EFFORT_LEVELS: readonly EffortLevel[] = EFFORT_LEVELS;
