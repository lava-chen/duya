import { frameRecord, frameString, TranscriptModel, type LegacyFrame } from './blocks.js';
import type { BackgroundTaskOutputV1 } from '@duya/agent-protocol';

export class SubagentTranscript {
  readonly model = new TranscriptModel();
  loadGeneration = 0;
  replaying = false;
  hasHistory = false;
  receivedProgress = false;
  private previousOutput: string | null = null;
  private readonly pendingTools: string[] = [];
  private nextToolId = 0;
  private brief = '';

  constructor(private readonly id: string) {}

  apply(data: Readonly<Record<string, unknown>>): boolean {
    const type = frameString(data, 'agentEventType');
    const payload = data['data'];
    switch (type) {
      case 'subagent_started':
      case 'started': {
        const brief = frameString(data, 'agentDescription') || frameString(data, 'agentType');
        if (brief !== '') this.brief = brief;
        if (this.brief === '' || this.model.blocks.length > 0) return false;
        this.model.addUser(this.brief);
        return true;
      }
      case 'text':
      case 'thinking': {
        const content = typeof payload === 'string' ? payload : frameString(frameRecord(payload), type);
        if (content === '') return false;
        this.receivedProgress = true;
        return this.model.apply({ type: data['partial'] === true ? `${type}_delta` : type, data: { content } }).kind !== 'none';
      }
      case 'tool_use': {
        this.receivedProgress = true;
        const callId = frameString(data, 'toolCallId');
        const id = callId || `subagent:${this.id}:${this.nextToolId++}`;
        if (callId === '') this.pendingTools.push(id);
        return this.pushToolFrame({ type, data: { id, name: frameString(data, 'toolName') || 'tool', input: data['toolInput'] ?? {} } });
      }
      case 'tool_result': {
        const id = frameString(data, 'toolCallId') || this.pendingTools.shift();
        if (id === undefined) return false;
        return this.pushToolFrame({ type, data: { id, result: frameString(data, 'toolResult'), error: data['toolError'] === true } });
      }
      case 'failed':
      case 'error':
        this.model.addError(frameString(data, 'summary') || (typeof payload === 'string' ? payload : 'Subagent failed'));
        this.model.finishRun();
        return true;
      case 'done':
      case 'completed':
      case 'subagent_completed':
        return this.model.finishRun();
      default:
        return false;
    }
  }

  /** The task log continues to grow after its parent run stream closes. */
  replay(output: BackgroundTaskOutputV1): boolean {
    if (output.text === '' || output.text === this.previousOutput) return false;
    const rows = output.text.split('\n');
    if (output.truncated) rows.shift();
    const events = rows.flatMap((row) => {
      try {
        const record = frameRecord(JSON.parse(row) as unknown);
        const payload = frameRecord(record['payload']);
        return typeof payload['type'] === 'string' ? [{ ...payload, agentEventType: payload['type'] }] : [];
      } catch {
        return [];
      }
    });
    if (events.length === 0) return false;
    this.previousOutput = output.text;
    this.replaying = true;
    this.nextToolId = 0;
    this.pendingTools.length = 0;
    this.model.clear();
    if (this.brief !== '') this.model.addUser(this.brief);
    for (const event of events) this.apply(event);
    return true;
  }

  private pushToolFrame(frame: LegacyFrame): boolean {
    return this.model.apply(frame).kind !== 'none';
  }
}
