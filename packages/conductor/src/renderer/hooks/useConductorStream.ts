// useConductorStream.ts - Hooks for conductor agent streaming
import { useEffect, useState, useCallback } from 'react';
import type { ConductorEvent, ConductorPhase } from '@/lib/stream-session-manager';
import {
  subscribeToConductorEvents,
  subscribeToConductorPhase,
  subscribeToConductorError,
  startConductorStream,
  stopConductorStream,
  handleConductorPortEvent,
} from '@/lib/stream-session-manager';

export interface ConductorStreamState {
  events: ConductorEvent[];
  phase: ConductorPhase;
  error: string | null;
  isActive: boolean;
}

/**
 * Hook to subscribe to conductor stream events
 */
export function useConductorStream(canvasId: string | null): ConductorStreamState {
  const [events, setEvents] = useState<ConductorEvent[]>([]);
  const [phase, setPhase] = useState<ConductorPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canvasId) return;

    const unsubEvents = subscribeToConductorEvents(canvasId, setEvents);
    const unsubPhase = subscribeToConductorPhase(canvasId, setPhase);
    const unsubError = subscribeToConductorError(canvasId, setError);

    return () => {
      unsubEvents();
      unsubPhase();
      unsubError();
    };
  }, [canvasId]);

  return {
    events,
    phase,
    error,
    isActive: phase !== 'idle' && phase !== 'completed' && phase !== 'error',
  };
}

/**
 * Hook to start and manage conductor stream
 */
export function useConductorStreamControl(canvasId: string | null) {
  const [isActive, setIsActive] = useState(false);

  const startStream = useCallback((params: {
    content: string;
    snapshot?: unknown;
    model?: string;
    visionModel?: string;
    permissionMode?: string;
  }) => {
    if (!canvasId) return;
    setIsActive(true);
    return startConductorStream({
      canvasId,
      content: params.content,
      snapshot: params.snapshot,
      model: params.model,
      visionModel: params.visionModel,
      permissionMode: params.permissionMode,
    });
  }, [canvasId]);

  const stopStream = useCallback(() => {
    if (!canvasId) return;
    stopConductorStream(canvasId);
    setIsActive(false);
  }, [canvasId]);

  const handleEvent = useCallback((eventType: string, data: unknown) => {
    if (!canvasId) return;
    handleConductorPortEvent(canvasId, eventType, data);
  }, [canvasId]);

  return {
    startStream,
    stopStream,
    handleEvent,
    isActive,
  };
}

/**
 * Parse conductor events to extract structured data
 */
export function useConductorStreamItems(canvasId: string | null) {
  const { events, phase, error } = useConductorStream(canvasId);

  // Extract latest text content
  const textContent = events
    .filter((e): e is ConductorEvent & { type: 'text' } => e.type === 'text')
    .map((e) => e.content)
    .join('');

  // Extract latest thinking content
  const thinkingContent = events
    .filter((e): e is ConductorEvent & { type: 'thinking' } => e.type === 'thinking')
    .map((e) => e.content)
    .join('');

  // Extract tool uses with their results
  const toolUses = events
    .filter((e): e is ConductorEvent & { type: 'tool_use' } => e.type === 'tool_use')
    .map((e) => e.toolUse);

  const toolResults = events
    .filter((e): e is ConductorEvent & { type: 'tool_result' } => e.type === 'tool_result')
    .map((e) => e.toolResult);

  // Pair tool uses with results
  const tools = toolUses.map((tool) => ({
    ...tool,
    result: toolResults.find((r) => r.tool_use_id === tool.id),
  }));

  return {
    textContent,
    thinkingContent,
    tools,
    phase,
    error,
  };
}
