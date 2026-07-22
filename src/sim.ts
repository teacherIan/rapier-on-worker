// The bring-your-own-sim contract. The harness owns the loop, the pool, and
// the protocol; YOU own the physics. Your sim is plain code that runs inside
// the worker — the harness never imports a physics engine, so any engine
// (Rapier, or none) works, and your worker file stays an ordinary app module
// (no library-shipped worker, no bundler special cases).

/** Sidecar returned by fillFrame: app data that rides along with the FRAME. */
export interface FrameFill<TExtra> {
  extra?: TExtra
  /** Transferables inside `extra` (e.g. a Float32Array's buffer). The frame
   * buffer itself is always transferred; list only your own additions. */
  transfer?: Transferable[]
}

/** A frame-shape announcement: the app-defined layout descriptor plus the
 * frame size in floats it implies. */
export interface SimLayout<TLayout> {
  layout: TLayout
  frameFloats: number
}

export interface WorkerSim<TInput, TCommand, TLayout, TExtra> {
  /**
   * Handle a structural command (spawn/remove/resize/configure...). Return the
   * new layout if the FRAME SHAPE may have changed — the harness bumps the
   * epoch, drops the pool, and announces LAYOUT — or null for commands that
   * leave the frame shape alone (e.g. a resize that moves bodies but not the
   * buffer format).
   *
   * Sims that grow continuously (spawners) should size frameFloats to CAPACITY
   * once and carry the live count in `extra`, so growth never churns epochs.
   */
  command(command: TCommand): SimLayout<TLayout> | null

  /**
   * Stage per-tick state from the latest INPUT before the fixed steps run.
   * `input` is the most recent one main sent (null if none yet). `epochOk` is
   * false when the input was stamped with a stale epoch — positional fields
   * (anything in current layout order) must then be ignored, but fields that
   * don't depend on the layout may still be applied.
   */
  beginTick(input: TInput | null, epochOk: boolean): void

  /** One fixed physics step. Called 0..maxSubsteps times per tick. */
  step(dt: number): void

  /**
   * Write the current frame into `out` (length = frameFloats of the current
   * layout). Optionally return sidecar data for the FRAME message.
   */
  fillFrame(out: Float32Array): FrameFill<TExtra> | undefined

  /**
   * The free-run pump (re)started after STOP or on first START: re-seed any
   * input-delta baselines so the first tick can't see a stale jump (e.g. a
   * pointer radius that moved while paused reading as a huge velocity).
   */
  onStart?(): void
}

/** What the sim factory returns: the sim, plus an optional initial layout to
 * announce immediately (sims that start empty omit it and announce their
 * first layout from a command instead). */
export interface SimSetup<TInput, TCommand, TLayout, TExtra> {
  sim: WorkerSim<TInput, TCommand, TLayout, TExtra>
  layout?: SimLayout<TLayout>
}

/** Builds the sim from the app-defined INIT payload. May be async (awaiting a
 * WASM init, for instance). */
export type SimFactory<TInit, TInput, TCommand, TLayout, TExtra> = (
  init: TInit,
) => SimSetup<TInput, TCommand, TLayout, TExtra> | Promise<SimSetup<TInput, TCommand, TLayout, TExtra>>

/**
 * Minimal structural view of a Worker / DedicatedWorkerGlobalScope / port.
 * Both harness halves speak to one of these, so tests (and exotic hosts) can
 * substitute a MessageChannel port or an in-memory pair. `ev` is typed loosely
 * because DOM's MessageEvent and the webworker lib's disagree; the harness
 * only ever reads `ev.data`.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage: ((ev: any) => void) | null
  terminate?(): void
}
