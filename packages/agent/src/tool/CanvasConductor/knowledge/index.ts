/**
 * Design knowledge sections for canvas_get_knowledge tool.
 *
 * Each section is a focused markdown blob the LLM can fetch on-demand
 * to get specific design guidance without bloating the system prompt.
 *
 * Content here is intentionally concrete: exact hex colors, exact
 * coordinates, exact field names. No generic advice — the model can
 * only act on specifics.
 *
 * One file per section lives under ./sections/. Add a new section by
 * dropping a new sections/<name>.ts that exports CONTENT, then
 * registering it in the KNOWLEDGE_SECTIONS record below.
 */

import { CONTENT as STICKY_STYLE } from './sections/sticky-style.js';
import { CONTENT as CONNECTOR_STYLE } from './sections/connector-style.js';
import { CONTENT as WIDGET_USAGE } from './sections/widget-usage.js';
import { CONTENT as WIDGET_DESIGN_SYSTEM } from './sections/widget-design-system.js';
import { CONTENT as WIDGET_TODOLIST } from './sections/widget-todolist.js';
import { CONTENT as FLOWCHART_LAYOUT } from './sections/flowchart-layout.js';
import { CONTENT as MINDMAP_LAYOUT } from './sections/mindmap-layout.js';
import { CONTENT as SCENE_BLUEPRINTS } from './sections/scene-blueprints.js';
import { CONTENT as TRAVEL_GUIDE } from './sections/travel-guide.js';

export type KnowledgeSection =
  | 'sticky-style'
  | 'connector-style'
  | 'widget-usage'
  | 'widget-design-system'
  | 'widget-todolist'
  | 'flowchart-layout'
  | 'mindmap-layout'
  | 'scene-blueprints'
  | 'travel-guide';

export const KNOWLEDGE_SECTIONS: Record<KnowledgeSection, string> = {
  'sticky-style': STICKY_STYLE,
  'connector-style': CONNECTOR_STYLE,
  'widget-usage': WIDGET_USAGE,
  'widget-design-system': WIDGET_DESIGN_SYSTEM,
  'widget-todolist': WIDGET_TODOLIST,
  'flowchart-layout': FLOWCHART_LAYOUT,
  'mindmap-layout': MINDMAP_LAYOUT,
  'scene-blueprints': SCENE_BLUEPRINTS,
  'travel-guide': TRAVEL_GUIDE,
};

export const KNOWLEDGE_SECTION_NAMES = Object.keys(KNOWLEDGE_SECTIONS) as KnowledgeSection[];