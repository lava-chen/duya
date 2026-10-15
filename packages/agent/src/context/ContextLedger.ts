/** Compatibility adapter for the Runtime-owned context accounting ledger. */
import { ContextLedger as RuntimeContextLedger } from '@duya/agent-runtime/context/compact'
import type {
  ContextEpochReason,
  ContextObservationInput,
  ContextWindowInfo,
} from '@duya/agent-runtime/context/compact'
import { createLegacyCompactionRuntimePorts } from '../compact/compaction-ports.js'

export type { ContextEpochReason, ContextObservationInput, ContextWindowInfo }
export type {
  ContextAccountingState,
  ContextObservation,
  ContextSnapshot,
  ContextWindowSource,
} from '@duya/agent-runtime/context/compact/contracts'

export class ContextLedger extends RuntimeContextLedger {
  constructor() {
    const ports = createLegacyCompactionRuntimePorts()
    super(ports.clock, ports.logger)
  }
}
