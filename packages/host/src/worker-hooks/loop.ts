export * from '@duya/agent-runtime/hooks/loop';
import {
  LoopHookBus as RuntimeLoopHookBus,
  applyLoopHookEffect as applyRuntimeEffect,
  type LoopHookEffect,
} from '@duya/agent-runtime/hooks/loop';
import type { Message } from '@duya/agent-protocol/transcript';
import { renderSystemReminder } from '@duya/agent-core/context/reminders';
import { projectRuntimeContextToProviderMessage } from '@duya/agent-core/message/message-projectors';
import { adaptLoopNudgeContext } from '../worker-context/runtime-context-adapters.js';
import { applyHookInjection, type InjectableMessage } from './injection.js';
import { logger } from '../worker-logger.js';

export class LoopHookBus extends RuntimeLoopHookBus {
  constructor() { super((message) => logger.warn(message)); }
}

export function applyLoopHookEffect(messages: Message[], effect: LoopHookEffect, seqIndex: number): void {
  applyRuntimeEffect(messages, effect, seqIndex, {
    project: (item, index) => projectRuntimeContextToProviderMessage(
      adaptLoopNudgeContext(renderSystemReminder(item.injection, 'loop_nudge'), item.source, { seqIndex: index }),
    ),
    applyGovernedInjection: (timeline, item, projected) => {
      if (typeof projected.content !== 'string') {
        logger.warn('[LoopHook] inject effect projected to non-string content; skipping');
        return;
      }
      applyHookInjection(timeline as unknown as InjectableMessage[], item.dedupKey,
        projected.content, item.source, { ...(projected.id === undefined ? {} : { id: projected.id }), now: Date.now() });
    },
  });
}
