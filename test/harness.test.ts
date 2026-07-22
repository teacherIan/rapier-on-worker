// End-to-end: both harness halves wired over an in-memory channel that uses
// REAL structuredClone-with-transfer semantics (buffers detach at the sender,
// exactly like a Worker boundary) and faked timers (the delivery hop and the
// worker's free-run pump are both setTimeout-driven, so tests are fully
// deterministic).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSimClient } from '../src/client'
import type { FrameFill, SimLayout, WorkerLike, WorkerSim } from '../src/sim'
import { attachSimWorker } from '../src/worker'

interface TestInput {
  v: number
}
type TestCommand = { kind: 'grow'; floats: number } | { kind: 'nudge' }
interface TestLayout {
  floats: number
}
interface TestExtra {
  stepCount: number
  radii: Float32Array
}

function createChannel(): [WorkerLike, WorkerLike] {
  let closed = false
  const make = (): WorkerLike & { _deliver?: never } => ({
    postMessage: () => {},
    onmessage: null,
    terminate: () => {
      closed = true
    },
  })
  const a = make()
  const b = make()
  const wire = (from: WorkerLike, to: WorkerLike) => {
    from.postMessage = (message: unknown, transfer?: Transferable[]) => {
      if (closed) return
      // Clone (and detach transferables) NOW, deliver on the next timer tick —
      // faithful to a real postMessage.
      const data = structuredClone(message, transfer ? { transfer } : undefined)
      setTimeout(() => {
        if (!closed) to.onmessage?.({ data })
      }, 0)
    }
  }
  wire(a, b)
  wire(b, a)
  return [a, b]
}

interface TestSimState {
  stepCount: number
  starts: number
  beginTicks: Array<{ input: TestInput | null; epochOk: boolean }>
  commands: TestCommand[]
}

function makeTestSim(): { sim: WorkerSim<TestInput, TestCommand, TestLayout, TestExtra>; state: TestSimState } {
  const state: TestSimState = { stepCount: 0, starts: 0, beginTicks: [], commands: [] }
  let floats = 0
  const sim: WorkerSim<TestInput, TestCommand, TestLayout, TestExtra> = {
    command(cmd): SimLayout<TestLayout> | null {
      state.commands.push(cmd)
      if (cmd.kind === 'grow') {
        floats = cmd.floats
        return { layout: { floats }, frameFloats: floats }
      }
      return null
    },
    beginTick(input, epochOk) {
      state.beginTicks.push({ input, epochOk })
    },
    step() {
      state.stepCount += 1
    },
    fillFrame(out): FrameFill<TestExtra> {
      for (let i = 0; i < out.length; i += 1) out[i] = state.stepCount * 1000 + i
      const radii = new Float32Array([state.stepCount])
      return { extra: { stepCount: state.stepCount, radii }, transfer: [radii.buffer] }
    },
    onStart() {
      state.starts += 1
    },
  }
  return { sim, state }
}

interface Harness {
  client: ReturnType<typeof createSimClient<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>>
  state: TestSimState
  frames: Array<{ positions: Float32Array; layout: TestLayout; extra: TestExtra | undefined }>
  layouts: TestLayout[]
  readyCount: () => number
  mainPort: WorkerLike
}

function boot(opts: { autoStart?: boolean; factoryDelayMs?: number } = {}): Harness {
  const [mainPort, workerPort] = createChannel()
  const { sim, state } = makeTestSim()
  attachSimWorker<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>(
    workerPort,
    opts.factoryDelayMs
      ? (init) =>
          new Promise((resolve) => setTimeout(() => resolve({ sim }), opts.factoryDelayMs)).then(() => {
            expect(init.w).toBe(640)
            return { sim }
          })
      : (init) => {
          expect(init.w).toBe(640)
          return { sim }
        },
  )
  const frames: Harness['frames'] = []
  const layouts: TestLayout[] = []
  let ready = 0
  const client = createSimClient<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>({
    worker: mainPort,
    init: { w: 640 },
    autoStart: opts.autoStart,
    onReady: () => {
      ready += 1
    },
    onLayout: (l) => layouts.push(l),
    onFrame: (f) => frames.push({ positions: f.positions.slice(), layout: f.layout, extra: f.extra }),
  })
  return { client, state, frames, layouts, readyCount: () => ready, mainPort }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('harness end-to-end', () => {
  it('boots: INIT → READY → autoStart, and queues pre-READY commands in order', async () => {
    const h = boot()
    // Sent before READY can possibly have arrived — must be queued, in order.
    h.client.sendCommand({ kind: 'nudge' })
    h.client.sendCommand({ kind: 'grow', floats: 8 })
    expect(h.client.ready()).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(h.client.ready()).toBe(true)
    expect(h.readyCount()).toBe(1)
    expect(h.state.commands).toEqual([{ kind: 'nudge' }, { kind: 'grow', floats: 8 }])
    expect(h.state.starts).toBe(1) // autoStart defaulted on
    expect(h.state.stepCount).toBeGreaterThan(0)
  })

  it('flows frames: layout announced, pool recycles, positions + extra arrive intact', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 6 })
    await vi.advanceTimersByTimeAsync(500)
    expect(h.layouts).toEqual([{ floats: 6 }])
    expect(h.client.layout()).toEqual({ floats: 6 })
    // Far more frames than pool buffers proves RETURN-based recycling works.
    expect(h.frames.length).toBeGreaterThan(6)
    for (const f of h.frames) {
      expect(f.positions.length).toBe(6)
      expect(f.layout).toEqual({ floats: 6 })
      // fillFrame wrote stepCount*1000 + i; extra carries the matching stepCount.
      expect(f.extra).toBeDefined()
      expect(f.positions[0]).toBe(f.extra!.stepCount * 1000)
      expect(f.positions[5]).toBe(f.extra!.stepCount * 1000 + 5)
      expect(f.extra!.radii).toBeInstanceOf(Float32Array)
      expect(f.extra!.radii[0]).toBe(f.extra!.stepCount)
    }
    // Frames are latest-wins montonic — extras' stepCounts strictly increase.
    const counts = h.frames.map((f) => f.extra!.stepCount)
    for (let i = 1; i < counts.length; i += 1) expect(counts[i]).toBeGreaterThan(counts[i - 1]!)
  })

  it('re-layouts cleanly: after a second grow, only new-shape frames are delivered', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 8 })
    await vi.advanceTimersByTimeAsync(200)
    const framesAtSwitch = h.frames.length
    expect(framesAtSwitch).toBeGreaterThan(0)
    h.client.sendCommand({ kind: 'grow', floats: 4 })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.layouts).toEqual([{ floats: 8 }, { floats: 4 }])
    const after = h.frames.slice(framesAtSwitch)
    expect(after.length).toBeGreaterThan(0)
    // No 8-float frame may arrive after the first 4-float frame (epoch guard).
    const firstNew = after.findIndex((f) => f.positions.length === 4)
    expect(firstNew).toBeGreaterThanOrEqual(0)
    for (const f of after.slice(firstNew)) {
      expect(f.positions.length).toBe(4)
      expect(f.layout).toEqual({ floats: 4 })
    }
  })

  it('stamps INPUT with the epoch: current input applies, post-relayout input reads epochOk=false', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(100)
    h.state.beginTicks.length = 0
    h.client.sendInput({ v: 42 })
    await vi.advanceTimersByTimeAsync(50)
    const ok = h.state.beginTicks.filter((t) => t.input?.v === 42)
    expect(ok.length).toBeGreaterThan(0)
    expect(ok.every((t) => t.epochOk)).toBe(true)

    // Input sent, then a re-layout lands before the client learns the new
    // epoch: the staged input turns stale → epochOk false, input still passed.
    h.client.sendInput({ v: 7 })
    h.client.sendCommand({ kind: 'grow', floats: 3 })
    await vi.advanceTimersByTimeAsync(100)
    const stale = h.state.beginTicks.filter((t) => t.input?.v === 7 && !t.epochOk)
    expect(stale.length).toBeGreaterThan(0)
  })

  it('STOP freezes the pump; START resumes with a fresh onStart and no catch-up burst', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(200)
    h.client.setRunning(false)
    await vi.advanceTimersByTimeAsync(50) // let the STOP land
    const frozenFrames = h.frames.length
    const frozenSteps = h.state.stepCount
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.state.stepCount).toBe(frozenSteps)
    expect(h.frames.length).toBe(frozenFrames)
    h.client.setRunning(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(h.state.starts).toBe(2)
    expect(h.frames.length).toBeGreaterThan(frozenFrames)
    // No catch-up burst for the 2s pause: ~6 steps for 100ms, not ~120.
    expect(h.state.stepCount - frozenSteps).toBeLessThan(12)
  })

  it('autoStart:false stays paused until setRunning(true); setRunning before READY latches', async () => {
    const h = boot({ autoStart: false, factoryDelayMs: 30 })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.client.ready()).toBe(true)
    expect(h.state.starts).toBe(0)
    expect(h.state.stepCount).toBe(0)

    const h2 = boot({ autoStart: false, factoryDelayMs: 30 })
    h2.client.setRunning(true) // before READY — must latch and win
    await vi.advanceTimersByTimeAsync(200)
    expect(h2.state.starts).toBe(1)
    expect(h2.state.stepCount).toBeGreaterThan(0)
  })

  it('terminate goes inert: no callbacks, no throws on late sends', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(100)
    const n = h.frames.length
    h.client.terminate()
    h.client.sendInput({ v: 1 })
    h.client.sendCommand({ kind: 'nudge' })
    h.client.setRunning(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(h.frames.length).toBe(n)
  })

  it('worker withholds frames when the pool is seeded with wrong-size buffers (silent-truncate guard)', async () => {
    // Drive the worker raw (no client) so we can violate the contract.
    const [mainPort, workerPort] = createChannel()
    const { sim } = makeTestSim()
    attachSimWorker<null, TestInput, TestCommand, TestLayout, TestExtra>(workerPort, () => ({ sim }))
    const received: Array<{ type: string }> = []
    mainPort.onmessage = (ev: { data: { type: string } }) => received.push(ev.data)
    mainPort.postMessage({ type: 'INIT', init: null })
    await vi.advanceTimersByTimeAsync(20)
    mainPort.postMessage({ type: 'START' })
    mainPort.postMessage({ type: 'COMMAND', command: { kind: 'grow', floats: 8 } })
    await vi.advanceTimersByTimeAsync(20)
    const layoutMsg = received.find((m) => m.type === 'LAYOUT') as { epoch: number } | undefined
    expect(layoutMsg).toBeDefined()
    // Seed with WRONG-size buffers at the right epoch.
    mainPort.postMessage({ type: 'INIT_POOL', buffers: [new ArrayBuffer(12)], epoch: layoutMsg!.epoch })
    await vi.advanceTimersByTimeAsync(300)
    expect(received.some((m) => m.type === 'FRAME')).toBe(false) // withheld, no crash
  })
})
