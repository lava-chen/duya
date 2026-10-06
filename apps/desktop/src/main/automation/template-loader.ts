import * as fs from 'fs';
import * as path from 'path';
import { getLogger, LogComponent } from '../logging/logger';
import { formatEveryDuration } from './schedule.js';
import type { AutomationTemplate, CronSchedule } from './types';

const logger = getLogger();

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, taking the whole graph with it, so `app` is resolved through a
 * guarded require and reported as absent instead.
 */
function electronAppPath(): string | undefined {
  try {
    const { app } = require('electron') as { app?: { getAppPath(): string } };
    return app && typeof app.getAppPath === 'function' ? app.getAppPath() : undefined;
  } catch {
    return undefined;
  }
}

function resolveTemplatesPath(): string | null {
  // `getAppPath()` is the INSTALLED APP's resource root and only exists under
  // Electron. Without it the remaining candidate is `process.resourcesPath`,
  // which plain Node does not define either — and templates ship as a bundled
  // app resource, so a headless control plane that has no app root has no
  // templates to load. Returning the function's existing "not found" answer is
  // honest; substituting the cwd would resolve against a directory nobody
  // chose. The caller already treats null as "no templates configured".
  const appPath = electronAppPath();
  const candidates = [
    ...(appPath ? [path.join(appPath, 'resources', 'automation-templates', 'templates.json')] : []),
    path.join(process.resourcesPath || '', 'automation-templates', 'templates.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Normalize a template's `defaultSchedule` into the new nested `CronSchedule`
 * shape. Accepts both the new fields (`expr`/`every`) and the legacy template
 * fields (`cronExpr`/`everyMs`) so older packaged template files keep working.
 */
function normalizeDefaultSchedule(schedule: Record<string, unknown>): CronSchedule | null {
  const kind = schedule.kind;
  if (kind === 'once') {
    if (typeof schedule.at !== 'string' || !schedule.at) return null;
    return { kind: 'once', at: schedule.at };
  }
  if (kind === 'every') {
    const every =
      typeof schedule.every === 'string' && schedule.every.trim()
        ? schedule.every.trim()
        : typeof schedule.everyMs === 'number'
          ? formatEveryDuration(schedule.everyMs)
          : '5m';
    return { kind: 'every', every };
  }
  if (kind === 'cron') {
    const expr = typeof schedule.expr === 'string' ? schedule.expr : typeof schedule.cronExpr === 'string' ? schedule.cronExpr : '';
    if (!expr) return null;
    const tz =
      typeof schedule.tz === 'string'
        ? schedule.tz
        : typeof schedule.cronTz === 'string'
          ? schedule.cronTz
          : null;
    return { kind: 'cron', expr, tz };
  }
  return null;
}

function validateTemplate(t: Record<string, unknown>): AutomationTemplate | null {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.prompt !== 'string' || !t.prompt) return null;
  if (!t.defaultSchedule || typeof t.defaultSchedule !== 'object') return null;
  const defaultSchedule = normalizeDefaultSchedule(t.defaultSchedule as Record<string, unknown>);
  if (!defaultSchedule) return null;
  return {
    id: t.id as string,
    icon: typeof t.icon === 'string' ? t.icon : 'gear',
    label_en: typeof t.label_en === 'string' ? t.label_en : (t.id as string),
    label_zh: typeof t.label_zh === 'string' ? t.label_zh : (t.id as string),
    description_en: typeof t.description_en === 'string' ? t.description_en : '',
    description_zh: typeof t.description_zh === 'string' ? t.description_zh : '',
    prompt: t.prompt as string,
    defaultSchedule,
    defaultModel: typeof t.defaultModel === 'string' ? t.defaultModel : undefined,
    tags: Array.isArray(t.tags) ? t.tags.filter((tag): tag is string => typeof tag === 'string') : [],
  };
}

let cachedTemplates: AutomationTemplate[] | null = null;

export function loadTemplates(): AutomationTemplate[] {
  if (cachedTemplates) return cachedTemplates;

  const filePath = resolveTemplatesPath();
  if (!filePath) {
    logger.warn('Template file not found at any candidate path', undefined, LogComponent.Automation);
    cachedTemplates = [];
    return cachedTemplates;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(raw);
    if (!config.templates || !Array.isArray(config.templates)) {
      logger.warn('Template config missing templates array', undefined, LogComponent.Automation);
      cachedTemplates = [];
      return cachedTemplates;
    }

    const templates: AutomationTemplate[] = [];
    for (const t of config.templates) {
      const validated = validateTemplate(t as Record<string, unknown>);
      if (validated) {
        templates.push(validated);
      } else {
        logger.warn(`Skipping invalid template: ${JSON.stringify(t)}`, undefined, LogComponent.Automation);
      }
    }

    cachedTemplates = templates;
    logger.info(`Loaded ${templates.length} automation templates`, undefined, LogComponent.Automation);
    return cachedTemplates;
  } catch (err) {
    logger.error(
      `Failed to load templates: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : new Error(String(err)),
      {},
      LogComponent.Automation,
    );
    cachedTemplates = [];
    return cachedTemplates;
  }
}

export function getTemplate(id: string): AutomationTemplate | undefined {
  return loadTemplates().find((t) => t.id === id);
}