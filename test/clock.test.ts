import { describe, expect, it } from 'vitest'
import { steppedClock } from '../src/clock'

const opts = { fixedDt: 1 / 60, maxSubsteps: 2, spiralClamp: 0.25 }

describe('steppedClock', () => {
  it('banks time and steps a whole number of fixed steps', () => {
    const dts: number[] = []
    const clock = steppedClock((dt) => dts.push(dt), opts)
    expect(clock.pump(1 / 120)).toBe(0) // half a step banked, nothing runs
    expect(clock.pump(1 / 120)).toBe(1) // bank reaches one step
    expect(dts).toEqual([1 / 60])
  })

  it('caps catch-up at maxSubsteps', () => {
    let steps = 0
    const clock = steppedClock(() => (steps += 1), opts)
    expect(clock.pump(0.1)).toBe(2) // 6 steps owed, cap at 2
    expect(steps).toBe(2)
  })

  it('drops the backlog when the cap is hit with more than a step still banked', () => {
    const clock = steppedClock(() => {}, opts)
    clock.pump(0.1) // hits the cap, banked remainder dropped
    expect(clock.pump(0)).toBe(0)
    expect(clock.pump(1 / 60)).toBe(1) // fresh bank behaves normally
  })

  it('keeps a sub-step remainder when the cap is hit with less than a step banked', () => {
    const clock = steppedClock(() => {}, { ...opts, maxSubsteps: 1 })
    // 1.5 steps arrive; 1 runs, 0.5 stays banked (below the drop threshold).
    expect(clock.pump(1.5 / 60)).toBe(1)
    expect(clock.pump(0.5 / 60)).toBe(1) // remainder + half = one full step
  })

  it('clamps a single huge frame to spiralClamp', () => {
    let steps = 0
    const clock = steppedClock(() => (steps += 1), { ...opts, maxSubsteps: 100 })
    clock.pump(10) // banked as 0.25s = 15 steps, not 600
    expect(steps).toBe(15)
  })

  it('reset drops banked time', () => {
    const clock = steppedClock(() => {}, opts)
    clock.pump(0.9 / 60)
    clock.reset()
    expect(clock.pump(0.5 / 60)).toBe(0) // the 0.9 is gone
  })
})
