import type { Message } from '../../types.js'
import { microCleanupMessages } from '../microCompactCleanup.js'

export const microTransform = {
  name: 'micro-compact',
  apply(messages: Message[]): Message[] {
    return microCleanupMessages(messages)
  },
}