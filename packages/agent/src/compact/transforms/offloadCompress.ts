import type { Message } from '../../types.js'

export const offloadTransform = {
  name: 'offload',
  apply(messages: Message[]): Message[] {
    return messages
  },
}