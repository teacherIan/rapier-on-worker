// Regression tests for the review-confirmed hazards: throw-safety on both
// halves, epoch/pool guards under contract violations, factory failure
// surfacing, transfer-detach contracts, and graceful degradation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachSimWorker } from '../src/worker'
import { createSimClient } from '../src/client'
import { boot, createChannel, makeTestSim, type TestCommand, type TestExtra, type TestInput, type TestLayout } from './helpers'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('throw-safety', () => {
  it('an onFrame throw still RETURNs the buffer: frames keep flowing after poolSize throws', async () => {
    let throwsLeft = 4 // > poolSize — without the finally-RETURN this starves the pool
    const delivered: number[] = []
    const h = boot({
      onFrame: (f) => {
        if (throwsLeft > 0) {
          throwsLeft -= 1
          throw new Error('onFrame boom')
        }
        delivered.push(f.positions.length)
      },
    })
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(500)
    expect(throwsLeft).toBe(0)
    expect(delivered.length).toBeGreaterThan(3) // recovered and kept delivering
    expect(h.channel.sunkErrors.length).toBe(4) // the throws surfaced, not swallowed silently
  })

  it('an onLayout throw cannot skip pool seeding: frames still flow for that epoch', async () => {
    const h = boot({
      onLayout: () => {
        throw new Error('onLayout boom')
      },
    })
    h.client.sendCommand({ kind: 'grow', floats: 3 })
    await vi.advanceTimersByTimeAsync(300)
    expect(h.frames.length).toBeGreaterThan(0) // pool was seeded before the callback threw
    expect(h.channel.sunkErrors.length).toBeGreaterThan(0)
  })

  it('a fillFrame throw neither kills the pump nor leaks the popped buffer', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(200)
    const before = h.frames.length
    h.state.throwNextFill = true
    // The throw propagates out of the worker's tick (an uncaught worker error
    // in production; here it rejects the timer advance) — absorb it.
    await vi.advanceTimersByTimeAsync(100).catch(() => {})
    await vi.advanceTimersByTimeAsync(300)
    // Pump survived AND the buffer went back: sustained flow needs all 3.
    expect(h.frames.length).toBeGreaterThan(before + 3)
  })
})

describe('INIT / factory failure', () => {
  it('a rejecting factory posts ERROR (onError fires); a fresh client can retry and succeed', async () => {
    const h = boot({ factoryRejects: 1 })
    await vi.advanceTimersByTimeAsync(50)
    expect(h.errors).toEqual(['factory boom'])
    expect(h.client.ready()).toBe(false)
    expect(h.factoryRuns()).toBe(1)

    // Retry: a new client on the same worker re-INITs (initStarted was reset).
    const frames: number[] = []
    const client2 = createSimClient<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>({
      worker: h.mainPort,
      init: { w: 640 },
      onFrame: (f) => frames.push(f.positions.length),
    })
    client2.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(300)
    expect(h.factoryRuns()).toBe(2)
    expect(client2.ready()).toBe(true)
    expect(frames.length).toBeGreaterThan(0)
  })

  it('duplicate INIT never re-runs the factory; after READY it replays READY + current layout', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 4 })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.factoryRuns()).toBe(1)
    const layoutsBefore = h.layouts.length

    // A second client attaching to the same (kept) worker re-INITs.
    const frames2: number[] = []
    let ready2 = 0
    const client2 = createSimClient<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>({
      worker: h.mainPort,
      init: { w: 640 },
      onReady: () => {
        ready2 += 1
      },
      onFrame: (f) => frames2.push(f.positions.length),
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(h.factoryRuns()).toBe(1) // factory NOT re-run
    expect(ready2).toBe(1) // READY replayed to the new client
    expect(client2.layout()).toEqual({ floats: 4 }) // layout replayed
    expect(frames2.length).toBeGreaterThan(0) // new epoch, new pool, frames flow
    expect(h.layouts.length).toBe(layoutsBefore) // old client saw nothing new (handler was replaced)
  })

  it('sendInput before READY is a silent no-op', async () => {
    const h = boot({ factoryDelayMs: 40 })
    h.client.sendInput({ v: 99 })
    await vi.advanceTimersByTimeAsync(300)
    expect(h.state.beginTicks.every((t) => t.input?.v !== 99)).toBe(true)
  })

  it('START during the factory await: pump arms, sim gets onStart on arrival, COMMAND pre-sim is dropped not crashed', async () => {
    const { ports } = createChannel()
    const [mainPort, workerPort] = ports
    const { sim, state } = makeTestSim()
    attachSimWorker<null, TestInput, TestCommand, TestLayout, TestExtra>(workerPort, async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { sim }
    })
    const received: Array<{ type: string }> = []
    mainPort.onmessage = (ev: { data: { type: string } }) => received.push(ev.data)
    mainPort.postMessage({ type: 'INIT', init: null })
    await vi.advanceTimersByTimeAsync(5)
    // Out-of-contract raw caller: START and COMMAND while the factory awaits.
    mainPort.postMessage({ type: 'START' })
    mainPort.postMessage({ type: 'COMMAND', command: { kind: 'grow', floats: 2 } })
    await vi.advanceTimersByTimeAsync(200)
    expect(received.some((m) => m.type === 'READY')).toBe(true)
    expect(state.starts).toBe(1) // the catch-up onStart fired when the sim arrived
    expect(state.stepCount).toBeGreaterThan(0) // pump is alive
    expect(state.commands).toEqual([]) // pre-sim COMMAND dropped, no crash
  })
})

describe('epoch and pool guards', () => {
  it('INIT_POOL with a stale epoch is ignored even when buffer sizes match', async () => {
    const { ports } = createChannel()
    const [mainPort, workerPort] = ports
    const { sim } = makeTestSim()
    attachSimWorker<null, TestInput, TestCommand, TestLayout, TestExtra>(workerPort, () => ({ sim }))
    const received: Array<{ type: string }> = []
    mainPort.onmessage = (ev: { data: { type: string } }) => received.push(ev.data)
    mainPort.postMessage({ type: 'INIT', init: null })
    await vi.advanceTimersByTimeAsync(20)
    mainPort.postMessage({ type: 'START' })
    mainPort.postMessage({ type: 'COMMAND', command: { kind: 'grow', floats: 4 } })
    await vi.advanceTimersByTimeAsync(20)
    const layoutMsg = received.find((m) => m.type === 'LAYOUT') as { epoch: number } | undefined
    expect(layoutMsg).toBeDefined()
    // Correct SIZE, stale EPOCH: the primary barrier must reject it — this is
    // exactly the case the byteLength net cannot catch.
    mainPort.postMessage({ type: 'INIT_POOL', buffers: [new ArrayBuffer(16)], epoch: layoutMsg!.epoch - 1 })
    await vi.advanceTimersByTimeAsync(300)
    expect(received.some((m) => m.type === 'FRAME')).toBe(false)
  })

  it('a frameFloats:0 layout quiesces frame traffic and a later layout recovers it', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 8 })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.frames.length).toBeGreaterThan(0)

    h.client.sendCommand({ kind: 'grow', floats: 0 })
    await vi.advanceTimersByTimeAsync(100)
    expect(h.layouts.at(-1)).toEqual({ floats: 0 }) // announced
    expect(h.client.layout()).toEqual({ floats: 0 })
    const quiesced = h.frames.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.frames.length).toBe(quiesced) // no frames during the empty epoch
    expect(h.state.stepCount).toBeGreaterThan(0) // the sim itself keeps stepping

    h.client.sendCommand({ kind: 'grow', floats: 4 })
    await vi.advanceTimersByTimeAsync(200)
    const after = h.frames.slice(quiesced)
    expect(after.length).toBeGreaterThan(0) // recovered
    expect(after.every((f) => f.positions.length === 4)).toBe(true)
  })

  it('a client poolSize larger than the worker cap degrades gracefully (extras dropped, flow sustained)', async () => {
    const h = boot({ clientPoolSize: 5 }) // worker cap stays 3
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(500)
    expect(h.frames.length).toBeGreaterThan(10) // steady flow on the capped pool
  })
})

describe('transfer contracts', () => {
  it('the sidecar transfer list actually transfers: the worker-side array detaches', async () => {
    const h = boot()
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(200)
    expect(h.frames.length).toBeGreaterThan(0)
    // The worker kept a reference to the radii it last shipped; a real
    // transfer detaches it (byteLength 0). A silent copy would keep it alive.
    expect(h.state.lastRadii).not.toBeNull()
    expect(h.state.lastRadii!.buffer.byteLength).toBe(0)
  })

  it('the onFrame positions view is dead after the callback returns (RETURN transfers the buffer)', async () => {
    let raw: Float32Array | null = null
    const h = boot({
      onFrame: (f) => {
        raw = f.positions // keeping the RAW view — violating the documented contract
      },
    })
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(200)
    expect(raw).not.toBeNull()
    // The view's buffer went back to the worker by transfer: detached, length 0.
    expect(raw!.length).toBe(0)
  })
})

describe('teardown', () => {
  it('terminate() on a terminate-less host still stops the pump via STOP', async () => {
    const h = boot()
    delete (h.mainPort as { terminate?: unknown }).terminate // a port-like host
    h.client.sendCommand({ kind: 'grow', floats: 2 })
    await vi.advanceTimersByTimeAsync(200)
    h.client.terminate()
    await vi.advanceTimersByTimeAsync(50) // let the STOP land
    const steps = h.state.stepCount
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.state.stepCount).toBe(steps) // worker is not free-running forever
  })
})
