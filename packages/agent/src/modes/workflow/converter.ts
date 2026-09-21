/**
 * converter.ts — recorded event stream → WorkflowDef (plan 556 Phase 3).
 *
 * The second definition producer, next to planner.ts: where the planner
 * turns a GOAL into YAML, the converter turns a RECORDED HUMAN
 * DEMONSTRATION (recorder events, plan 556 Phase 0 contract) into the
 * same WorkflowDef shape, validated by the same `validateWorkflow` —
 * record and plan converge on one execution surface (556 §2).
 *
 * Mapping (design doc §4.6):
 *   app_focus app change  → phase boundary (`app-<n>`; schema caps 8
 *                           phases — overflow merges the tail segments
 *                           into the last phase's node list)
 *   phase first interaction → `{ do: 'capture' }` step (SOM baseline)
 *   click                 → `{ do: 'click', element: 'som:<n>' }`
 *   type                  → `{ do: 'type_text', text, element: 'som:<n>' }`
 *                           (redacted password text recorded verbatim +
 *                           annotation `paramHint: true`)
 *   key combo / named key → `{ do: 'key', key }`
 *   scroll                → `{ do: 'scroll', direction, amount }`
 *   browserUrl change     → capture injected before that step
 *   irreversible          → human approval node inserted BEFORE the
 *                           phase's gui node (timeout.on_timeout required
 *                           by schema; `fail` = never replay unapproved)
 *
 * Irreversible detection mirrors the planner's rule pass exactly
 * (`RULE_RISK_RE` over element name / typed text) and additionally
 * gates every MenuItem click — menu items dispatch commands directly.
 *
 * `som:<n>` refs are a converter-issued GLOBAL counter (som:1, som:2,
 * …). Replay-time resolution against a fresh SOM index is the
 * element-matcher's job (Phase 4): every ref is annotated on its gui
 * node under `annotation.som` with the recorded ElementDescriptor +
 * click point.
 *
 * Pure function: events in, result out; never throws. Validation
 * failures surface as `ok: false` + errors; non-fatal degradations
 * (skipped right-clicks, dropped focus transits) ride along as
 * warnings.
 */

import { z } from 'zod';
import {
  ElementDescriptorSchema,
  REDACTED_TEXT,
  type AppRef,
  type ElementDescriptor,
  type RecorderEvent,
} from '@duya/computer-use';

import { SOM_ELEMENT_RE, type GuiStep, type WorkflowDef, type WorkflowNode, type WorkflowPhase } from './schema.js';
import { RULE_RISK_RE } from './planner.js';
import { validateWorkflow, type ValidationError } from './validate.js';

// ─── annotation contract (consumed by element-matcher, plan 556 Phase 4) ───

/** One `som:<n>` ref's recorded provenance, keyed by the ref itself. */
export const RecorderSomRefAnnotationSchema = z.object({
  ts: z.number(),
  element: ElementDescriptorSchema,
  /** Recorded click point (logical screen px) — matcher L1/L2 input. */
  point: z.object({ x: z.number(), y: z.number() }).optional(),
  /** OS click count (2 = double-click collapsed by the aggregator). */
  clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Browser URL observed at event time — assertion clue. */
  browserUrl: z.string().optional(),
  /** Text is a redaction placeholder — convert to params before replay. */
  paramHint: z.boolean().optional(),
});
export type RecorderSomRefAnnotation = z.infer<typeof RecorderSomRefAnnotationSchema>;

/** Shape stored on every converter-produced gui node's `annotation`. */
export const RecorderNodeAnnotationSchema = z.object({
  source: z.literal('recorder'),
  app: z.string(),
  windowTitle: z.string(),
  browserUrl: z.string().optional(),
  som: z.record(z.string().regex(SOM_ELEMENT_RE), RecorderSomRefAnnotationSchema),
});
export type RecorderNodeAnnotation = z.infer<typeof RecorderNodeAnnotationSchema>;

// ─── public API ───

export interface ConvertEventsOptions {
  /** Override the auto-generated kebab-case workflow name. */
  name?: string;
  /** Override the generated description. */
  description?: string;
}

export interface ConvertEventsResult {
  ok: boolean;
  /** The converted def — present even when invalid so UI can preview YAML. */
  def?: WorkflowDef;
  errors: ValidationError[];
  warnings: string[];
}

/** Schema cap: WorkflowDefSchema.phases max(8). */
const MAX_PHASES = 8;

const INTERACTIVE_TYPES = new Set(['click', 'type', 'key', 'scroll']);

/**
 * Convert a recorded event stream (from a recorder session) into a
 * validated WorkflowDef. Total function — returns a result object,
 * never throws.
 */
export function convertEventsToWorkflow(
  events: readonly RecorderEvent[],
  options: ConvertEventsOptions = {},
): ConvertEventsResult {
  const warnings: string[] = [];
  const segments = segmentByApp(events, warnings);
  if (segments.length === 0) {
    return {
      ok: false,
      errors: [{ path: 'events', message: 'no interactive events recorded — nothing to convert' }],
      warnings,
    };
  }

  const overflow = Math.max(0, segments.length - MAX_PHASES);
  if (overflow > 0) {
    warnings.push(
      `${segments.length} app segments exceed the ${MAX_PHASES}-phase schema cap; ` +
        `the last ${overflow + 1} merged into phase ${MAX_PHASES}`,
    );
  }

  // One GLOBAL som counter across the whole def — a ref identifies at
  // most one recorded interaction, which the matcher keys off.
  let somCounter = 0;
  const phases: WorkflowPhase[] = [];
  let totalInteractions = 0;

  segments.forEach((seg, segIdx) => {
    const segNo = segIdx + 1;
    const phaseNo = Math.min(segNo, MAX_PHASES);
    const appName = safeText(seg.app.name || seg.app.processName || `app ${segNo}`, 128);

    const built = buildSegmentSteps(seg, appName, warnings, () => `som:${++somCounter}`);
    totalInteractions += built.interactions;

    const guiNode: WorkflowNode = {
      id: `app-${segNo}-gui`,
      gui: { target_app: appName, steps: built.steps, on_stuck: 'agent' },
      annotation: {
        source: 'recorder',
        app: appName,
        windowTitle: safeText(seg.app.title ?? '', 256),
        ...(built.lastUrl ? { browserUrl: built.lastUrl } : {}),
        som: built.som,
      } satisfies RecorderNodeAnnotation,
    };

    const phaseIdx = phaseNo - 1;
    let phase = phases[phaseIdx];
    if (!phase) {
      phase = {
        phase: `app-${phaseNo}`,
        title: appName,
        ...(seg.app.title ? { detail: safeText(`recorded window "${seg.app.title}" (pid ${seg.app.pid})`, 1024) } : {}),
        nodes: [],
      };
      phases[phaseIdx] = phase;
    }
    // Human gate BEFORE the gui node (plan 556 §4.6: 前插).
    if (built.irreversibleReasons.length > 0) {
      phase.nodes.push({
        id: `app-${segNo}-approve`,
        human: {
          prompt:
            `Recorded step(s) in "${appName}" look irreversible ` +
            `(${built.irreversibleReasons.join('; ')}). Approve to let the replay continue.`,
          timeout: { hours: 24, on_timeout: 'fail' },
        },
      });
    }
    phase.nodes.push(guiNode);
  });

  const def: WorkflowDef = {
    name: options.name ?? autoName(segments),
    description:
      options.description ??
      `Recorded human demonstration: ${totalInteractions} interaction(s) across ` +
        `${segments.length} app segment(s). Converted by the duya recorder (plan 556).`,
    when_to_use: 'Replays a recorded human demonstration of this desktop flow.',
    phases,
  };

  const validation = validateWorkflow(def);

  // Template-syntax guard. Recorded text is literal data; `${...}` in a
  // step either fails validation or — for `params.*` roots, which
  // validation whitelists — SILENTLY interpolates at replay, corrupting
  // the recorded input. Fail the conversion with the step's location;
  // the def is still returned so the UI can preview and hand-edit.
  const templateErrors: ValidationError[] = [];
  for (const phase of def.phases) {
    for (const node of phase.nodes) {
      for (const step of node.gui?.steps ?? []) {
        if ('text' in step && typeof step.text === 'string' && step.text.includes('${')) {
          templateErrors.push({
            path: `${node.id}.gui.steps`,
            message:
              `recorded typed text contains template syntax ("${step.text.slice(0, 60)}") — ` +
              'edit the step text or convert it to a param',
          });
        }
      }
    }
  }

  return {
    ok: validation.ok && templateErrors.length === 0 && validation.def !== undefined,
    def,
    errors: [...templateErrors, ...validation.errors],
    warnings,
  };
}

/**
 * Irreversible-action test shared by the step scan: element name or
 * typed text hits the planner's RULE_RISK_RE, or the element is a
 * MenuItem (menu items dispatch commands directly — conservative gate).
 */
export function isIrreversibleElement(element: ElementDescriptor, text?: string): boolean {
  if (element.controlType === 'MenuItem') return true;
  if (element.name && RULE_RISK_RE.test(element.name)) return true;
  if (text && RULE_RISK_RE.test(text)) return true;
  return false;
}

// ─── segmentation ───

interface Segment {
  app: AppRef;
  events: RecorderEvent[];
}

function appKey(app: AppRef): string {
  return `${app.processName.toLowerCase()}#${app.pid}`;
}

/**
 * Split the stream into per-app segments in arrival order. `app_focus`
 * and interactive events start a new segment when the app identity
 * (processName + pid) changes; window open/close are context only.
 * Focus-only transits are dropped, and a transit-split pair of
 * same-app segments is merged back so alt-tab excursions don't shatter
 * one app's flow (order is preserved regardless).
 */
function segmentByApp(events: readonly RecorderEvent[], warnings: string[]): Segment[] {
  const raw: Segment[] = [];
  let current: Segment | undefined;
  for (const event of events) {
    if (event.type === 'window_open' || event.type === 'window_close') {
      current?.events.push(event);
      continue;
    }
    const key = appKey(event.app);
    const boundary = event.type === 'app_focus' || INTERACTIVE_TYPES.has(event.type);
    if (!current || (boundary && key !== appKey(current.app))) {
      current = { app: event.app, events: [event] };
      raw.push(current);
    } else {
      current.events.push(event);
    }
  }

  const segments: Segment[] = [];
  let dropped = 0;
  for (const seg of raw) {
    if (!seg.events.some((e) => INTERACTIVE_TYPES.has(e.type))) {
      dropped++;
      continue;
    }
    const last = segments[segments.length - 1];
    if (last && appKey(last.app) === appKey(seg.app)) {
      last.events.push(...seg.events);
    } else {
      segments.push(seg);
    }
  }
  if (dropped > 0) {
    warnings.push(`${dropped} app focus transit(s) without interaction dropped`);
  }
  return segments;
}

interface SegmentBuild {
  steps: GuiStep[];
  som: Record<string, RecorderSomRefAnnotation>;
  irreversibleReasons: string[];
  interactions: number;
  lastUrl?: string;
}

/**
 * One segment → gui steps + per-som annotation. Capture is injected
 * before the first interaction and on every browserUrl change; the
 * recorded click/type element lands in `som` for the matcher.
 */
function buildSegmentSteps(
  seg: Segment,
  appName: string,
  warnings: string[],
  nextSom: () => string,
): SegmentBuild {
  const steps: GuiStep[] = [{ do: 'capture' }];
  const som: Record<string, RecorderSomRefAnnotation> = {};
  const irreversibleReasons: string[] = [];
  let interactions = 0;
  let lastUrl: string | undefined;
  let pendingCapture = false;

  for (const event of seg.events) {
    if (event.type === 'app_focus') {
      if (event.browserUrl && event.browserUrl !== lastUrl) {
        lastUrl = event.browserUrl;
        pendingCapture = true;
      }
      continue;
    }
    if (event.type === 'window_open' || event.type === 'window_close') continue;

    let urlChanged = false;
    if ('browserUrl' in event && event.browserUrl !== undefined && event.browserUrl !== lastUrl) {
      lastUrl = event.browserUrl;
      urlChanged = true;
    }
    // Inject at most one capture — never back-to-back with the seed
    // capture or a capture a previous URL change already emitted.
    const lastStep = steps[steps.length - 1];
    if ((pendingCapture || urlChanged) && lastStep?.do !== 'capture') {
      steps.push({ do: 'capture' });
    }
    pendingCapture = false;

    switch (event.type) {
      case 'click': {
        if (event.click.button !== 'left') {
          warnings.push(
            `${event.click.button}-click in "${appName}" at (${event.click.x}, ${event.click.y}) ` +
              'cannot be represented as a gui step — skipped',
          );
          break;
        }
        const ref = nextSom();
        steps.push({ do: 'click', element: ref });
        som[ref] = {
          ts: event.ts,
          element: event.element,
          point: { x: event.click.x, y: event.click.y },
          clickCount: event.click.count,
          ...(event.browserUrl ? { browserUrl: event.browserUrl } : {}),
        };
        if (isIrreversibleElement(event.element)) {
          irreversibleReasons.push(describeElement(event.element));
        }
        interactions++;
        break;
      }
      case 'type': {
        if (event.text.length === 0) break;
        const ref = nextSom();
        const password = event.element.isPassword === true || event.text === REDACTED_TEXT;
        // Redacted text is recorded verbatim (plan 556: 密码脱敏文本照录);
        // paramHint marks it for conversion to params before replay.
        steps.push({ do: 'type_text', text: event.text, element: ref });
        som[ref] = {
          ts: event.ts,
          element: event.element,
          ...(password ? { paramHint: true } : {}),
          ...(event.browserUrl ? { browserUrl: event.browserUrl } : {}),
        };
        if (isIrreversibleElement(event.element, event.text)) {
          irreversibleReasons.push(describeElement(event.element));
        }
        interactions++;
        break;
      }
      case 'key': {
        steps.push({ do: 'key', key: event.key });
        interactions++;
        break;
      }
      case 'scroll': {
        steps.push({ do: 'scroll', direction: event.direction, amount: event.amount });
        interactions++;
        break;
      }
    }
  }

  if (steps.length === 1) {
    // No step survived filtering (e.g. all clicks were right-clicks) —
    // the bare capture keeps the node schema-valid.
    warnings.push(`no representable interaction in "${appName}" — capture-only gui node`);
  }
  return { steps, som, irreversibleReasons, interactions, lastUrl };
}

// ─── helpers ───

/** Element label for the human prompt — provenance only, sanitized. */
function describeElement(element: ElementDescriptor): string {
  const label = element.name ? `"${safeText(element.name, 80)}"` : 'unnamed element';
  return element.controlType ? `${element.controlType} ${label}` : label;
}

/**
 * Sanitize recorded strings that may end up in template-scanned or
 * interpolated fields: `${` would be parsed as a template at replay /
 * validation time; recorded text is literal data.
 */
function safeText(input: string, max: number): string {
  return input.replace(/\$\{/g, '{').replace(/\s+/g, ' ').trim().slice(0, max);
}

function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function autoName(segments: Segment[]): string {
  const apps = [...new Set(segments.map((s) => slug(s.app.processName || s.app.name)))].filter(Boolean).slice(0, 2);
  const base = ['recorded', ...apps].join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (base || 'recorded-session').slice(0, 64);
}
