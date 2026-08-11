import type { Message } from '../../types.js'
import { compressHistoricalCanvasToolCalls } from '../canvasHistoryCompress.js'

export const canvasTransform = {
  name: 'canvas-compress',
  apply(messages: Message[]): Message[] {
    return compressHistoricalCanvasToolCalls(messages)
  },
}