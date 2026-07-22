// Main-thread side of the free-running sim worker. The worker is the clock;
// this client just (a) streams the latest render-side INPUT fire-and-forget,
// (b) consumes FRAMEs latest-wins — handing positions to onFrame and
// immediately RETURNing the buffer to the pool — and (c) re-seeds the buffer
// pool on every layout change. No SharedArrayBuffer.
import { POOL_SIZE, type MainToWorker, type WorkerToMain } from './protocol'
import type { WorkerLike } from './sim'

export interface SimFrame<TLayout, TExtra> {
  /**
   * The frame's floats, wrapped over the transferred buffer — valid ONLY for
   * the duration of the onFrame call. The client RETURNs the buffer to the
   * worker's pool the moment onFrame returns, so copy out what you keep.
   */
  positions: Float32Array
  /** The layout this frame was produced under (same epoch, guaranteed). */
  layout: TLayout
  extra: TExtra | undefined
}

export interface SimClientOptions<TInit, TLayout, TExtra> {
  /** The Worker you created (`new Worker(new URL('./your.worker.ts',
   * import.meta.url), { type: 'module' })`) — or anything worker-shaped. */
  worker: WorkerLike
  /** App-defined INIT payload, handed to your sim factory in the worker. */
  init: TInit
  /** Called once per published frame. Copy synchronously — see SimFrame. */
  onFrame: (frame: SimFrame<TLayout, TExtra>) => void
  /** The worker's sim factory resolved; commands now flow. */
  onReady?: () => void
  /** A new layout was announced (the pool re-seeds automatically). */
  onLayout?: (layout: TLayout) => void
  /** Frame buffers per epoch; must match the worker's. Default POOL_SIZE (3). */
  poolSize?: number
  /** Send START as soon as the worker is READY. Default true. */
  autoStart?: boolean
}

export interface SimClient<TInput, TCommand, TLayout> {
  /** True once the worker reported READY. */
  ready(): boolean
  /** The most recent announced layout (null before the first LAYOUT). */
  layout(): TLayout | null
  /**
   * Fire-and-forget the latest render-side input (call at most once per rAF).
   * List transferables inside `input` (e.g. a Float32Array's buffer) in
   * `transfer`. Dropped before READY — inputs are ephemeral by design.
   */
  sendInput(input: TInput, transfer?: Transferable[]): void
  /** Send a structural command. Queued (in order) until the worker is READY. */
  sendCommand(command: TCommand): void
  /** Pause/resume the worker's free-run pump (e.g. on document visibility). */
  setRunning(on: boolean): void
  /** Terminate the underlying worker. The client goes inert. */
  terminate(): void
}

export function createSimClient<TInit, TInput, TCommand, TLayout, TExtra>(
  options: SimClientOptions<TInit, TLayout, TExtra>,
): SimClient<TInput, TCommand, TLayout> {
  const { worker, poolSize = POOL_SIZE, autoStart = true } = options

  let isReady = false
  let layout: TLayout | null = null
  let frameFloats = 0
  let epoch = 0
  let latestSeq = -1
  let terminated = false
  /** setRunning() before READY latches here and wins over autoStart. */
  let desiredRunning: boolean | null = null
  const preReadyCommands: TCommand[] = []

  const post = (msg: MainToWorker<TInit, TInput, TCommand>, transfer?: Transferable[]) =>
    worker.postMessage(msg, transfer)

  worker.onmessage = (event: { data: unknown }) => {
    if (terminated) return
    const msg = event.data as WorkerToMain<TLayout, TExtra>
    if (msg.type === 'READY') {
      isReady = true
      for (const command of preReadyCommands.splice(0)) post({ type: 'COMMAND', command })
      if (desiredRunning ?? autoStart) post({ type: 'START' })
      options.onReady?.()
    } else if (msg.type === 'LAYOUT') {
      layout = msg.layout
      frameFloats = msg.frameFloats
      epoch = msg.epoch
      latestSeq = -1
      options.onLayout?.(msg.layout)
      // Seed the new epoch's pool: exactly poolSize buffers of the right size.
      // Old-epoch buffers are dropped (the worker cleared its pool; stale
      // FRAMEs still in transit just GC).
      if (frameFloats > 0) {
        const buffers: ArrayBuffer[] = []
        for (let i = 0; i < poolSize; i += 1) buffers.push(new ArrayBuffer(frameFloats * 4))
        post({ type: 'INIT_POOL', buffers, epoch }, buffers)
      }
    } else if (msg.type === 'FRAME') {
      // Drop stale (wrong-epoch) or out-of-order frames; return a same-epoch
      // buffer to the pool, otherwise let the old-epoch buffer GC.
      if (msg.epoch !== epoch || msg.seq <= latestSeq) {
        if (msg.epoch === epoch) post({ type: 'RETURN', buf: msg.buf, epoch }, [msg.buf])
        return
      }
      latestSeq = msg.seq
      // Hand the frame out (onFrame copies what it keeps), then immediately
      // RETURN the buffer so the worker's pool never starves.
      options.onFrame({ positions: new Float32Array(msg.buf), layout: layout as TLayout, extra: msg.extra })
      post({ type: 'RETURN', buf: msg.buf, epoch }, [msg.buf])
    }
  }

  post({ type: 'INIT', init: options.init })

  return {
    ready: () => isReady,
    layout: () => layout,
    sendInput(input: TInput, transfer?: Transferable[]) {
      if (!isReady || terminated) return
      post({ type: 'INPUT', input, epoch }, transfer)
    },
    sendCommand(command: TCommand) {
      if (terminated) return
      if (!isReady) {
        preReadyCommands.push(command)
        return
      }
      post({ type: 'COMMAND', command })
    },
    setRunning(on: boolean) {
      if (terminated) return
      if (!isReady) {
        desiredRunning = on
        return
      }
      post({ type: on ? 'START' : 'STOP' })
    },
    terminate() {
      terminated = true
      worker.terminate?.()
    },
  }
}
