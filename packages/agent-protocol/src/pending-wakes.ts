/** The durable pending-wake kinds currently supported by @duya/data. */
export type HostPendingWakeKind =
  | 'task.completion'
  | 'automation.fire'
  | 'connector.inbound'
  | 'broadcast'
  | 'user.message'
  | 'agent.dm'

export type HostPendingWakeLane = 'user' | 'agent' | 'background'

/** Client-safe view of a durable pending-wake row. */
export interface HostPendingWakeRow {
  readonly kind: HostPendingWakeKind
  readonly workId: string
  readonly agentId: string
  readonly lane: HostPendingWakeLane
  readonly markedAtMs: number
  readonly title: string | null
  readonly quietOriginJson: string | null
}

export interface HostPendingWakeInput {
  readonly kind: HostPendingWakeKind
  readonly workId: string
  readonly agentId: string
  readonly lane?: HostPendingWakeLane
  readonly title?: string | null
  readonly quietOriginJson?: string | null
}

/** Local Host API for durable queue markers; never exposes SQL or DB handles. */
export interface HostLocalPendingWakeApiV1 {
  getPendingWake(kind: HostPendingWakeKind, workId: string): Promise<HostPendingWakeRow | null>
  persistPendingWake(input: HostPendingWakeInput): Promise<void>
  clearPendingWake(kind: HostPendingWakeKind, workId: string): Promise<boolean>
  listPendingWakes(): Promise<readonly HostPendingWakeRow[]>
  pruneStalePendingWakes(beforeMs?: number): Promise<number>
}
