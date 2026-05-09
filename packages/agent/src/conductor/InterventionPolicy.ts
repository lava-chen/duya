export type InterventionLevel =
  | 'silent'
  | 'suggest'
  | 'preview'
  | 'confirm'
  | 'confirm_undoable';

export type InterventionTrigger =
  | 'user_active_input'
  | 'agent_passive_perception'
  | 'structural_change'
  | 'widget_delete'
  | 'batch_update'
  | 'text_suggestion';

export interface InterventionDecision {
  level: InterventionLevel;
  reason: string;
  requiresConfirmation: boolean;
  timeoutMs?: number;
}

export interface InterventionPolicyConfig {
  defaultTimeoutMs: number;
}

const DEFAULT_CONFIG: InterventionPolicyConfig = {
  defaultTimeoutMs: 30000,
};

const POLICY_TABLE: Record<InterventionTrigger, InterventionLevel> = {
  user_active_input: 'silent',
  agent_passive_perception: 'suggest',
  structural_change: 'confirm',
  widget_delete: 'confirm_undoable',
  batch_update: 'preview',
  text_suggestion: 'suggest',
};

const HIGH_RISK_TOOLS = new Set([
  'conductor_create_widget',
  'conductor_move_widget',
  'conductor_delete_widget',
  'canvas_create_element',
  'canvas_delete_element',
]);

const MEDIUM_RISK_TOOLS = new Set([
  'conductor_update_widget_data',
  'conductor_auto_layout',
  'canvas_update_element',
  'canvas_arrange_elements',
]);

const LOW_RISK_TOOLS = new Set([
  'conductor_get_snapshot',
  'conductor_suggest_widget',
  'canvas_get_snapshot',
]);

export class InterventionPolicy {
  private config: InterventionPolicyConfig;

  constructor(config: Partial<InterventionPolicyConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  evaluateToolCall(toolName: string, _toolInput: Record<string, unknown>, context: {
    triggeredBy: InterventionTrigger;
    isBatchPart?: boolean;
  }): InterventionDecision {
    const baseLevel = POLICY_TABLE[context.triggeredBy];

    let level: InterventionLevel;

    if (HIGH_RISK_TOOLS.has(toolName)) {
      level = toolName === 'conductor_delete_widget' ? 'confirm_undoable' : 'confirm';
    } else if (MEDIUM_RISK_TOOLS.has(toolName)) {
      if (context.triggeredBy === 'user_active_input') {
        level = 'silent';
      } else {
        level = 'preview';
      }
    } else if (LOW_RISK_TOOLS.has(toolName)) {
      level = baseLevel === 'silent' ? 'silent' : 'suggest';
    } else {
      level = 'confirm';
    }

    if (context.isBatchPart && level === 'confirm') {
      level = 'confirm';
    }

    return {
      level,
      reason: `Tool ${toolName} with trigger ${context.triggeredBy} → ${level}`,
      requiresConfirmation: level === 'confirm' || level === 'confirm_undoable',
      timeoutMs: this.config.defaultTimeoutMs,
    };
  }

  evaluateBatch(tools: Array<{ name: string; input: Record<string, unknown> }>, trigger: InterventionTrigger): InterventionDecision {
    let maxLevel: InterventionLevel = 'silent';

    for (const tool of tools) {
      const decision = this.evaluateToolCall(tool.name, tool.input, {
        triggeredBy: trigger,
        isBatchPart: true,
      });

      const levelRank: Record<InterventionLevel, number> = {
        silent: 0,
        suggest: 1,
        preview: 2,
        confirm: 3,
        confirm_undoable: 4,
      };

      if (levelRank[decision.level] > levelRank[maxLevel]) {
        maxLevel = decision.level;
      }
    }

    return {
      level: maxLevel,
      reason: `Batch of ${tools.length} tools → ${maxLevel}`,
      requiresConfirmation: maxLevel === 'confirm' || maxLevel === 'confirm_undoable',
      timeoutMs: this.config.defaultTimeoutMs,
    };
  }
}

let policyInstance: InterventionPolicy | null = null;

export function getInterventionPolicy(): InterventionPolicy {
  if (!policyInstance) {
    policyInstance = new InterventionPolicy();
  }
  return policyInstance;
}

export function resetInterventionPolicy(): void {
  policyInstance = null;
}
