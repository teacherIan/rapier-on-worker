// Fixed-timestep accumulator (Glenn Fiedler's "Fix Your Timestep"). Decouples the
// physics step rate from the render/pump rate so the sim behaves the same regardless
// of frame rate: it banks elapsed time and runs `step(fixedDt)` a whole number of
// times, capped per frame so a slow frame can't spiral into an ever-growing catch-up.
//
// Pure + realm-portable: no DOM, no engine imports — it runs on a main thread
// (driven by rAF / a PIXI Ticker) and inside a worker (driven by setTimeout) alike.

export interface SteppedClock {
  /**
   * Advance by one frame's worth of elapsed time and run `step(fixedDt)` between
   * 0 and maxSubsteps times. Returns the number of substeps taken (callers that
   * publish a frame only when the sim actually advanced use this).
   */
  pump(frameSeconds: number): number
  /** Drop any banked time. Call when a paused loop resumes so a stale backlog
   *  doesn't burst as a multi-step catch-up on the first frame. */
  reset(): void
}

export interface SteppedClockOptions {
  /** Simulation timestep in seconds (constant, so force scaling is constant). */
  fixedDt: number
  /** Catch-up cap: at most this many steps per pump. */
  maxSubsteps: number
  /** Max frame delta (s) fed to the accumulator; longer stalls are clamped. */
  spiralClamp: number
}

export function steppedClock(step: (dt: number) => void, opts: SteppedClockOptions): SteppedClock {
  const { fixedDt, maxSubsteps, spiralClamp } = opts
  let acc = 0
  return {
    pump(frameSeconds: number): number {
      // Clamp the frame delta first: a long stall (tab backgrounded, GC pause)
      // would otherwise bank a huge backlog and freeze the sim catching up.
      acc += Math.min(spiralClamp, frameSeconds)
      let steps = 0
      while (acc >= fixedDt && steps < maxSubsteps) {
        step(fixedDt)
        acc -= fixedDt
        steps += 1
      }
      // Spiral-of-death guard: hit the substep cap with time still banked → drop
      // it. The sim slips a little rather than spending ever more time per frame
      // catching up.
      if (steps === maxSubsteps && acc > fixedDt) acc = 0
      return steps
    },
    reset() {
      acc = 0
    },
  }
}
