import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { getLogger, LogComponent } from '../logging/logger';
import type { AutomationTemplate } from './types';

const logger = getLogger();

function resolveTemplatesPath(): string | null {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'automation-templates', 'templates.json'),
    path.join(process.resourcesPath || '', 'automation-templates', 'templates.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function validateTemplate(t: Record<string, unknown>): AutomationTemplate | null {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.id !== 'string' || !t.id) return null;
  if (typeof t.prompt !== 'string' || !t.prompt) return null;
  if (!t.defaultSchedule || typeof t.defaultSchedule !== 'object') return null;
  const schedule = t.defaultSchedule as Record<string, unknown>;
  if (!schedule.kind || typeof schedule.kind !== 'string') return null;
  return {
    id: t.id as string,
    icon: typeof t.icon === 'string' ? t.icon : 'gear',
    label_en: typeof t.label_en === 'string' ? t.label_en : (t.id as string),
    label_zh: typeof t.label_zh === 'string' ? t.label_zh : (t.id as string),
    description_en: typeof t.description_en === 'string' ? t.description_en : '',
    description_zh: typeof t.description_zh === 'string' ? t.description_zh : '',
    prompt: t.prompt as string,
    defaultSchedule: {
      kind: schedule.kind as 'at' | 'every' | 'cron',
      at: typeof schedule.at === 'string' ? schedule.at : undefined,
      everyMs: typeof schedule.everyMs === 'number' ? schedule.everyMs : undefined,
      cronExpr: typeof schedule.cronExpr === 'string' ? schedule.cronExpr : undefined,
      cronTz: (typeof schedule.cronTz === 'string' ? schedule.cronTz : null),
    },
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
    logger.error(`Failed to load templates: ${err instanceof Error ? err.message : String(err)}`, undefined, LogComponent.Automation);
    cachedTemplates = [];
    return cachedTemplates;
  }
}

export function getTemplate(id: string): AutomationTemplate | undefined {
  return loadTemplates().find((t) => t.id === id);
}