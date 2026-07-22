// The message contract between the main thread (render) and the sim worker,
// for a FREE-RUNNING loop.
//
// Ownership model: the WORKER is the clock. It free-runs a fixed-timestep loop,
// applies the latest main-supplied INPUT each tick, steps the sim, and — if it
// owns a free pool buffer — transfers ONE filled frame buffer to main as a
// FRAME (latest-wins). Main copies the frame out and immediately RETURNs the
// buffer so the pool never starves. No SharedArrayBuffer / Atomics; every
// cross-thread payload moves by transfer, so the host app never needs
// cross-origin isolation (COOP/COEP) — popup auth flows and cross-origin
// embeds keep working.
//
// Pool/epoch invariant: per epoch there are exactly poolSize frame buffers.
// On any layout change (a COMMAND whose handler returns a new layout) the
// worker bumps the epoch, drops its whole pool, and stops publishing until
// main re-seeds via INIT_POOL stamped with the new epoch. FRAME / RETURN /
// INPUT carrying a stale epoch are dropped (INPUT is surfaced to the sim with
// an `epochOk` flag so non-positional fields can still be honoured).

/** Frame buffers in flight per epoch. 3 lets the worker fill one while main
 * holds one and a third is in transit, without ever stalling the worker. */
export const POOL_SIZE = 3

// ---- Main -> Worker -------------------------------------------------------

export interface InitMsg<TInit> {
  type: 'INIT'
  init: TInit
}

/** Seed (or re-seed after a layout change) the worker's frame-buffer pool.
 * Each buffer is `frameFloats * 4` bytes. All buffers are transferred. */
export interface InitPoolMsg {
  type: 'INIT_POOL'
  buffers: ArrayBuffer[]
  epoch: number
}

/** Latest-wins render-side state, fire-and-forget (typically once per rAF);
 * the worker stages the most recent one and applies it at the next tick. */
export interface InputMsg<TInput> {
  type: 'INPUT'
  input: TInput
  epoch: number
}

/** An app-defined structural message (spawn/remove/resize/configure...). The
 * worker hands it to the sim; if the sim reports a new layout, the epoch
 * bumps and a LAYOUT is announced. */
export interface CommandMsg<TCommand> {
  type: 'COMMAND'
  command: TCommand
}

/** Main hands a spent frame buffer back to the worker's pool. */
export interface ReturnMsg {
  type: 'RETURN'
  buf: ArrayBuffer
  epoch: number
}

/** Start/stop the worker's free-run pump (e.g. STOP on document.hidden so a
 * hidden tab doesn't burn a core; START on visible). */
export interface StartMsg {
  type: 'START'
}
export interface StopMsg {
  type: 'STOP'
}

export type MainToWorker<TInit, TInput, TCommand> =
  | InitMsg<TInit>
  | InitPoolMsg
  | InputMsg<TInput>
  | CommandMsg<TCommand>
  | ReturnMsg
  | StartMsg
  | StopMsg

// ---- Worker -> Main -------------------------------------------------------

/** The sim factory resolved; the worker now accepts commands/input. */
export interface ReadyMsg {
  type: 'READY'
}

/** The frame shape changed: here is the app-defined layout descriptor, the
 * new frame size in floats, and the new epoch. Main re-seeds the pool. */
export interface LayoutMsg<TLayout> {
  type: 'LAYOUT'
  layout: TLayout
  frameFloats: number
  epoch: number
}

export interface FrameMsg<TExtra> {
  type: 'FRAME'
  /** The filled frame (`frameFloats` floats). Main re-wraps as Float32Array,
   * copies out, and RETURNs it. Transferred. */
  buf: ArrayBuffer
  /** App-defined per-frame sidecar (counts, radii...). May carry its own
   * transferables via FrameFill.transfer. */
  extra: TExtra | undefined
  /** Monotonic; lets main drop an out-of-order/duplicate frame. */
  seq: number
  epoch: number
}

export type WorkerToMain<TLayout, TExtra> = ReadyMsg | LayoutMsg<TLayout> | FrameMsg<TExtra>
