// run-display/dwf-preview.ts — static flow preview for never-run .dwf.ts definitions.
//
// A saved workflow's script is plain TypeScript, so the stage structure can be
// approximated WITHOUT running anything: scan the source in order for `wf.*`
// calls and map each to the same chip vocabulary StageColumns already renders.
// This is deliberately a *rough* read ("大概的渲染出来流程"): template-literal
// arguments, conditionals and `wf.map` fan-out shape are not interpreted — a
// real run's journal remains the only precise record.

import type { RunStepNodeKind } from '@/types/stream';
import type { StageStep } from './stage-columns';

export interface DwfPreviewStep extends StageStep {
  status: 'pending';
}

/**
 * wf.phase('name')          → divider (cuts the rail into stage columns)
 * wf.agent('agent:研究员')  → agent chip
 * wf.tool('Bash', ...)      → script chip (aggregated per column)
 * wf.gui({ ... })           → script chip
 * wf.approve('...')         → human chip (prompt truncated)
 * wf.decide([...])          → decision chip
 * wf.publish('name')        → script chip (the deliverable itself is unknown
 *                             until the run produces it)
 *
 * wf.log / wf.map are skipped — map's inner calls are scanned in place.
 */
const CALL_RE =
  /\bwf\.(phase|agent|tool|publish|approve)\s*\(\s*(['"`])((?:\\.|(?!\2).){1,120}?)\2|\bwf\.(gui|decide|browser)\s*\(/g;

/** Full-line comments only: inline `//` inside string literals (URLs etc.) stays. */
function stripComments(script: string): string {
  return script
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/** Human chips carry prompts — cap them so a long prompt does not bloat the rail. */
const HUMAN_LABEL_MAX = 24;

export function parseDwfPreviewSteps(script: string): DwfPreviewStep[] {
  if (!script) return [];
  const text = stripComments(script);
  const steps: DwfPreviewStep[] = [];
  let index = 0;

  for (const match of text.matchAll(CALL_RE)) {
    const verb = match[1] ?? match[4];
    if (!verb) continue;
    index += 1;
    const id = `preview-${String(index).padStart(3, '0')}-${verb}`;
    const rawLabel = match[3]?.replace(/\\(['"`])/g, '$1');

    switch (verb) {
      case 'phase':
        steps.push({ id, label: rawLabel, status: 'pending', nodeKind: 'phase' });
        break;
      case 'agent':
        steps.push({ id, label: rawLabel, status: 'pending', nodeKind: 'agent' });
        break;
      case 'tool':
        steps.push({ id, label: rawLabel, status: 'pending', nodeKind: 'tool' });
        break;
      case 'publish':
        steps.push({ id, label: rawLabel, status: 'pending', nodeKind: 'tool' });
        break;
      case 'approve':
        steps.push({
          id,
          label: rawLabel && rawLabel.length > HUMAN_LABEL_MAX ? `${rawLabel.slice(0, HUMAN_LABEL_MAX)}…` : rawLabel,
          status: 'pending',
          nodeKind: 'human',
        });
        break;
      case 'gui':
        steps.push({ id, status: 'pending', nodeKind: 'gui' });
        break;
      case 'browser':
        steps.push({ id, status: 'pending', nodeKind: 'browser' });
        break;
      case 'decide':
        steps.push({ id, status: 'pending', nodeKind: 'decision' });
        break;
    }
  }

  return steps;
}
