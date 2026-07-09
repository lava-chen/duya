import { createSignal } from './signal.js'

export type QueryGuardState = 'idle' | 'dispatching' | 'running'

export class QueryGuard {
  private _state: QueryGuardState = 'idle'
  private _generation = 0
  private signal = createSignal()

  get state(): QueryGuardState {
    return this._state
  }

  get isIdle(): boolean {
    return this._state === 'idle'
  }

  get isDispatching(): boolean {
    return this._state === 'dispatching'
  }

  get isRunning(): boolean {
    return this._state === 'running'
  }

  get generation(): number {
    return this._generation
  }

  subscribe(callback: () => void): () => void {
    return this.signal.subscribe(callback)
  }

  tryStart(): boolean {
    if (this._state !== 'idle') {
      return false
    }
    this._state = 'dispatching'
    this.signal.emit()
    return true
  }

  markRunning(): void {
    if (this._state !== 'dispatching' && this._state !== 'idle') {
      return
    }
    this._state = 'running'
    this._generation++
    this.signal.emit()
  }

  reserve(): boolean {
    return this.tryStart()
  }

  end(): void {
    if (this._state !== 'running') {
      return
    }
    this._state = 'idle'
    this.signal.emit()
  }

  forceEnd(): void {
    this._state = 'idle'
    this.signal.emit()
  }

  cancelReservation(): void {
    if (this._state !== 'dispatching') {
      return
    }
    this._state = 'idle'
    this.signal.emit()
  }

  assertRunning(): boolean {
    return this._state === 'running'
  }
}

// Global singleton QueryGuard instance.
// NOTE: This singleton was created for an earlier architecture where a
// single guard serialized all agent queries within the process. In the
// current per-session worker model, each agent process handles one
// session and the guard is effectively process-scoped. Kept for
// backward compatibility with any external imports; do not remove
// without auditing all import sites. If you need a per-session guard,
// instantiate `new QueryGuard()` explicitly instead of using this export.
export const queryGuard = new QueryGuard()