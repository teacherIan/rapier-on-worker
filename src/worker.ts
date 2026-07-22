// Worker-side harness: the free-running clock that owns the sim.
//
// Call `runSimWorker(factory)` from YOUR worker file (the file you pass to
// `new Worker(new URL(...))` in the app). The harness self-paces a fixed-
// timestep loop (accumulator with substep + spiral caps), applies the latest
// main-supplied INPUT each tick, steps your sim, and transfers ONE filled
// frame buffer to main when the pool has a free buffer (latest-wins).
import { steppedClock } from './clock.js'
import { POOL_SIZE, type InputMsg, type MainToWorker, type WorkerToMain } from './protocol.js'
import type { SimFactory, SimLayout, WorkerLike, WorkerSim } from './sim.js'

export interface SimWorkerOptions {
  /** Sim timestep in seconds. Default 1/60. */
  fixedDt?: number
  /** Pump cadence in ms. Default 1000/60 — well clear of setTimeout's 4ms clamp. */
  targetMs?: number
  /** Catch-up cap per tick. Default 2 (contact solving is usually the CPU bound). */
  maxSubsteps?: number
  /** Max frame delta (s) banked by the accumulator. Default 0.25. */
  spiralClamp?: number
  /** Frame buffers per epoch; must match the client's. Default POOL_SIZE (3). */
  poolSize?: number
}

/** Attach the harness to an explicit worker context (exposed for tests; apps
 * normally call `runSimWorker`, which attaches to `self`). */
export function attachSimWorker<TInit, TInput, TCommand, TLayout, TExtra>(
  ctx: WorkerLike,
  factory: SimFactory<TInit, TInput, TCommand, TLayout, TExtra>,
  opts: SimWorkerOptions = {},
): void {
  const fixedDt = opts.fixedDt ?? 1 / 60
  const targetMs = opts.targetMs ?? 1000 / 60
  const maxSubsteps = opts.maxSubsteps ?? 2
  const spiralClamp = opts.spiralClamp ?? 0.25
  const poolSize = opts.poolSize ?? POOL_SIZE

  let sim: WorkerSim<TInput, TCommand, TLayout, TExtra> | null = null
  let initStarted = false
  let epoch = 0
  let frameFloats = 0
  let lastLayout: SimLayout<TLayout> | null = null
  let seq = 0

  // --- free-run pump state ---
  let running = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = 0
  let staged: InputMsg<TInput> | null = null

  // --- transferable frame-buffer pool (per epoch) ---
  let freePool: ArrayBuffer[] = []
  let poolValid = false

  const post = (msg: WorkerToMain<TLayout, TExtra>, transfer?: Transferable[]) =>
    ctx.postMessage(msg, transfer)

  const clock = steppedClock((dt) => sim?.step(dt), { fixedDt, maxSubsteps, spiralClamp })

  // Layout changed: bump the epoch and drop the whole pool in ONE place, then
  // stop publishing until main re-seeds with a matching-epoch INIT_POOL.
  function announceLayout(l: SimLayout<TLayout>): void {
    epoch += 1
    frameFloats = l.frameFloats
    lastLayout = l
    freePool = []
    poolValid = false
    post({ type: 'LAYOUT', layout: l.layout, frameFloats, epoch })
  }

  function publish(): void {
    if (!sim) return
    const buf = freePool.pop()
    if (!buf) return
    // Defense-in-depth: a wrong-size buffer would silently truncate (out-of-
    // range typed-array writes are ignored, not thrown). The epoch barrier
    // already guarantees a match; bail rather than ship a partial frame if
    // that ever breaks.
    if (buf.byteLength !== frameFloats * 4) {
      freePool.push(buf)
      return
    }
    // A throw ANYWHERE here — fillFrame OR the post (a bad transfer list, a
    // non-cloneable extra) — must not leak the popped buffer: return it to the
    // pool and rethrow (tick's finally keeps the pump alive). Otherwise one
    // buffer leaks per failing tick and the pool starves for good after
    // poolSize ticks, permanently freezing the render.
    try {
      const fill = sim.fillFrame(new Float32Array(buf))
      seq += 1
      // De-dupe the transfer list: a sim that lists out.buffer (=== buf, since
      // out wraps buf) would otherwise make postMessage throw DataCloneError on
      // the duplicate ArrayBuffer.
      const transfer: Transferable[] = [buf]
      if (fill?.transfer) for (const t of fill.transfer) if (t !== buf) transfer.push(t)
      post({ type: 'FRAME', buf, extra: fill?.extra, seq, epoch }, transfer)
    } catch (err) {
      freePool.push(buf)
      throw err
    }
  }

  function tick(): void {
    if (!running) return
    const now = performance.now()
    const frameTime = (now - last) / 1000 // raw; the clock clamps to spiralClamp
    last = now

    // The re-arm lives in finally: a throw from the sim's beginTick/step/
    // fillFrame surfaces as an uncaught worker error (visible), but must not
    // kill the loop while `running` is still true — START would then be a
    // no-op and the sim would be dead with no recovery path.
    try {
      if (sim) {
        const input = staged
        sim.beginTick(input ? input.input : null, input ? input.epoch === epoch : false)
        const steps = clock.pump(frameTime)
        if (steps > 0 && poolValid && frameFloats > 0) publish()
      }
      // No sim yet: skip the pump entirely (the clock banks nothing until the
      // sim exists, so there's no runaway accumulator to reset). `last` still
      // advanced above so the first real frame uses a normal delta.
    } finally {
      if (running) timer = setTimeout(tick, targetMs)
    }
  }

  function startPump(): void {
    if (running) return
    running = true
    last = performance.now()
    clock.reset()
    // Arm the loop BEFORE the sim's onStart so a throwing onStart can't
    // strand `running=true` with no timer.
    timer = setTimeout(tick, targetMs)
    sim?.onStart?.()
  }

  function stopPump(): void {
    running = false
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
  }

  ctx.onmessage = (event: { data: unknown }) => {
    const msg = event.data as MainToWorker<TInit, TInput, TCommand> | null
    if (!msg) return

    switch (msg.type) {
      case 'INIT': {
        if (initStarted) {
          // A second client attached to a kept worker re-INITs. Don't re-run
          // the factory — replay READY (and the current layout, which bumps
          // the epoch so the new client seeds a fresh pool) once the sim is
          // up. A re-INIT while the first factory is still awaiting just
          // rides the pending READY.
          if (sim) {
            post({ type: 'READY' })
            if (lastLayout) announceLayout(lastLayout)
          }
          return
        }
        initStarted = true
        void (async () => {
          let setup
          try {
            setup = await factory(msg.init)
          } catch (err) {
            // Surface the failure — an unhandled worker rejection never
            // reaches the parent Worker's error event, so without this the
            // client would hang pre-READY forever. Allow a retry INIT.
            initStarted = false
            post({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) })
            return
          }
          // A factory that forgot to `return` (or returned a malformed setup)
          // would otherwise set sim=undefined, post READY, and hang the client
          // forever (commands dropped, no frames). Fail loudly instead.
          if (!setup || typeof setup.sim !== 'object' || setup.sim === null) {
            initStarted = false
            post({ type: 'ERROR', message: 'sim factory must return { sim, layout? }' })
            return
          }
          sim = setup.sim
          // If the pump was STARTed while the factory awaited (the client only
          // sends START after READY, so only exotic callers hit this), the sim
          // missed its onStart — give it one now.
          if (running) sim.onStart?.()
          post({ type: 'READY' })
          if (setup.layout) announceLayout(setup.layout)
        })()
        return
      }

      case 'START':
        startPump()
        return

      case 'STOP':
        stopPump()
        return

      case 'INPUT':
        staged = msg // latest-wins
        return

      case 'INIT_POOL': {
        // Ignore a pool seeded for an epoch we've already moved past.
        if (msg.epoch !== epoch) return
        freePool = msg.buffers.slice()
        poolValid = true
        return
      }

      case 'RETURN': {
        // Re-accept only current-epoch buffers, capped at poolSize; drop the rest.
        if (msg.epoch === epoch && poolValid && freePool.length < poolSize) {
          freePool.push(msg.buf)
        }
        return
      }

      case 'COMMAND': {
        // The client queues commands until READY, so a null sim here means an
        // out-of-contract caller; dropping is the safe response.
        if (!sim) return
        const l = sim.command(msg.command)
        if (l) announceLayout(l)
        return
      }
    }
  }
}

/** Entry point for the app's worker file: attach the harness to `self`. */
export function runSimWorker<TInit, TInput, TCommand, TLayout, TExtra>(
  factory: SimFactory<TInit, TInput, TCommand, TLayout, TExtra>,
  opts?: SimWorkerOptions,
): void {
  // `self` typed structurally so the app can compile against the DOM lib
  // without the webworker lib (which double-declares globals).
  attachSimWorker(self as unknown as WorkerLike, factory, opts)
}
