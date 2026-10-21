/** Compatibility adapter for the Runtime-owned timeline compaction bridge. */
import {
  MessageCompactionController as RuntimeMessageCompactionController,
  type MessageCompactionControllerOptions as RuntimeMessageCompactionControllerOptions,
  type CompactionManagerLike,
  type CompactProactiveOptions,
} from '@duya/agent-runtime/context/compact'
import { createLegacyCompactionRuntimePorts } from './bound-ports.js'

export type { CompactionManagerLike, CompactProactiveOptions }
export type MessageCompactionControllerOptions = Omit<
  RuntimeMessageCompactionControllerOptions,
  'contextModel' | 'logger'
>

export class MessageCompactionController extends RuntimeMessageCompactionController {
  constructor(options: MessageCompactionControllerOptions) {
    const ports = createLegacyCompactionRuntimePorts()
    super({
      ...options,
      contextModel: ports.contextModel,
      logger: ports.logger,
      clock: options.clock ?? (() => ports.clock.now()),
    })
  }
}
