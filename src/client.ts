// Main-thread side of the free-running sim worker. The worker is the clock;
// this client just (a) streams the latest render-side INPUT fire-and-forget,
// (b) consumes FRAMEs latest-wins — handing positions to onFrame and
// immediately RETURNing the buffer to the pool — and (c) re-seeds the buffer
// pool on every layout change. No SharedArrayBuffer.
import { POOL_SIZE, type MainToWorker, type WorkerToMain } from './protocol.js'
import type { WorkerLike } from './sim.js'

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
   * import.meta.url), { type: 'module' })`) — or anything worker-shaped.
   * One client per worker: the client owns `onmessage`. */
  worker: WorkerLike
  /** App-defined INIT payload, handed to your sim factory in the worker. */
  init: TInit
  /** Called once per published frame. Copy synchronously — see SimFrame. */
  onFrame: (frame: SimFrame<TLayout, TExtra>) => void
  /** The worker's sim factory resolved; commands now flow. */
  onReady?: () => void
  /** A new layout was announced (the pool has already been re-seeded). */
  onLayout?: (layout: TLayout) => void
  /** The worker's sim factory threw/rejected (e.g. a WASM load failed). The
   * worker allows a retry: construct a new client, or resend nothing and
   * surface the failure to the app. Without this hook the failure is only
   * visible on the worker's console. */
  onError?: (message: string) => void
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
  /** Stop the pump and terminate the underlying worker. The client goes inert. */
  terminate(): void
}

/**
 * TInput/TCommand cannot be inferred from the options (they only appear in
 * the returned client), so they default to `never`: an inference-only call
 * site gets a client whose sendInput/sendCommand reject every argument — a
 * loud compile error prompting explicit type arguments — instead of silently
 * typing them as `unknown` and accepting anything.
 */
export function createSimClient<TInit, TInput = never, TCommand = never, TLayout = unknown, TExtra = unknown>(
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
      // Seed the new epoch's pool FIRST — before the user callback, so a
      // throwing onLayout can't leave the epoch poolless (the worker would
      // then step forever publishing nothing, with no retry path). Exactly
      // poolSize buffers of the right size; old-epoch buffers are dropped
      // (the worker cleared its pool; stale FRAMEs still in transit just GC).
      if (frameFloats > 0) {
        const buffers: ArrayBuffer[] = []
        for (let i = 0; i < poolSize; i += 1) buffers.push(new ArrayBuffer(frameFloats * 4))
        post({ type: 'INIT_POOL', buffers, epoch }, buffers)
      }
      options.onLayout?.(msg.layout)
    } else if (msg.type === 'FRAME') {
      // Drop stale (wrong-epoch) or out-of-order frames; return a same-epoch
      // buffer to the pool, otherwise let the old-epoch buffer GC.
      if (msg.epoch !== epoch || msg.seq <= latestSeq) {
        if (msg.epoch === epoch) post({ type: 'RETURN', buf: msg.buf, epoch }, [msg.buf])
        return
      }
      latestSeq = msg.seq
      // Hand the frame out (onFrame copies what it keeps), then RETURN the
      // buffer so the worker's pool never starves. The RETURN lives in
      // finally: an onFrame throw must not leak the buffer — poolSize throws
      // would otherwise starve the sim permanently.
      try {
        options.onFrame({ positions: new Float32Array(msg.buf), layout: layout as TLayout, extra: msg.extra })
      } finally {
        post({ type: 'RETURN', buf: msg.buf, epoch }, [msg.buf])
      }
    } else if (msg.type === 'ERROR') {
      options.onError?.(msg.message)
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
      if (terminated) return
      terminated = true
      // STOP first: WorkerLike.terminate is optional (MessageChannel-port
      // hosts have none), and without this the worker's pump would free-run
      // forever into an inert client. Harmless for real Workers — the post
      // just precedes the termination.
      post({ type: 'STOP' })
      worker.terminate?.()
    },
  }
}
