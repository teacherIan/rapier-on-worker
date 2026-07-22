// Shared test rig: an in-memory channel with REAL structuredClone-with-transfer
// semantics (buffers detach at the sender, exactly like a Worker boundary),
// setTimeout-driven delivery (so fake timers control it), and browser-faithful
// error handling — a throw inside a message handler is sunk and recorded, the
// way an uncaught event-handler error never stops later deliveries.
import type { FrameFill, SimLayout, WorkerLike, WorkerSim } from '../src/sim'
import { attachSimWorker, type SimWorkerOptions } from '../src/worker'
import { createSimClient, type SimClientOptions } from '../src/client'

export interface TestInput {
  v: number
}
export type TestCommand = { kind: 'grow'; floats: number } | { kind: 'nudge' }
export interface TestLayout {
  floats: number
}
export interface TestExtra {
  stepCount: number
  radii: Float32Array
}

export interface Channel {
  ports: [WorkerLike, WorkerLike]
  /** Errors thrown by message handlers, sunk like uncaught event errors. */
  sunkErrors: unknown[]
}

export function createChannel(): Channel {
  let closed = false
  const sunkErrors: unknown[] = []
  const make = (): WorkerLike => ({
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
      // Clone (and detach transferables) NOW, deliver on the next timer tick.
      const data = structuredClone(message, transfer ? { transfer } : undefined)
      setTimeout(() => {
        if (closed) return
        try {
          to.onmessage?.({ data })
        } catch (err) {
          sunkErrors.push(err)
        }
      }, 0)
    }
  }
  wire(a, b)
  wire(b, a)
  return { ports: [a, b], sunkErrors }
}

export interface TestSimState {
  stepCount: number
  starts: number
  beginTicks: Array<{ input: TestInput | null; epochOk: boolean }>
  commands: TestCommand[]
  /** The worker-side reference to the last sidecar array — for detach checks. */
  lastRadii: Float32Array | null
  /** Set true to make the next fillFrame throw (one-shot). */
  throwNextFill: boolean
}

export function makeTestSim(): { sim: WorkerSim<TestInput, TestCommand, TestLayout, TestExtra>; state: TestSimState } {
  const state: TestSimState = {
    stepCount: 0,
    starts: 0,
    beginTicks: [],
    commands: [],
    lastRadii: null,
    throwNextFill: false,
  }
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
      if (state.throwNextFill) {
        state.throwNextFill = false
        throw new Error('fillFrame boom')
      }
      for (let i = 0; i < out.length; i += 1) out[i] = state.stepCount * 1000 + i
      const radii = new Float32Array([state.stepCount])
      state.lastRadii = radii
      return { extra: { stepCount: state.stepCount, radii }, transfer: [radii.buffer] }
    },
    onStart() {
      state.starts += 1
    },
  }
  return { sim, state }
}

export interface BootOpts {
  autoStart?: boolean
  factoryDelayMs?: number
  /** Number of INITs whose factory rejects before one succeeds. */
  factoryRejects?: number
  clientPoolSize?: number
  workerOpts?: SimWorkerOptions
  onFrame?: SimClientOptions<{ w: number }, TestLayout, TestExtra>['onFrame']
  onLayout?: (layout: TestLayout) => void
  onError?: (message: string) => void
}

export interface Harness {
  client: ReturnType<typeof createSimClient<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>>
  state: TestSimState
  frames: Array<{ positions: Float32Array; layout: TestLayout; extra: TestExtra | undefined }>
  layouts: TestLayout[]
  errors: string[]
  readyCount: () => number
  factoryRuns: () => number
  channel: Channel
  mainPort: WorkerLike
  workerPort: WorkerLike
}

export function boot(opts: BootOpts = {}): Harness {
  const channel = createChannel()
  const [mainPort, workerPort] = channel.ports
  const { sim, state } = makeTestSim()
  let factoryRuns = 0
  let rejectsLeft = opts.factoryRejects ?? 0
  attachSimWorker<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>(
    workerPort,
    async (init) => {
      factoryRuns += 1
      if (init.w !== 640) throw new Error('bad init payload')
      if (rejectsLeft > 0) {
        rejectsLeft -= 1
        throw new Error('factory boom')
      }
      if (opts.factoryDelayMs) await new Promise((r) => setTimeout(r, opts.factoryDelayMs))
      return { sim }
    },
    opts.workerOpts,
  )
  const frames: Harness['frames'] = []
  const layouts: TestLayout[] = []
  const errors: string[] = []
  let ready = 0
  const client = createSimClient<{ w: number }, TestInput, TestCommand, TestLayout, TestExtra>({
    worker: mainPort,
    init: { w: 640 },
    autoStart: opts.autoStart,
    poolSize: opts.clientPoolSize,
    onReady: () => {
      ready += 1
    },
    onLayout: opts.onLayout ?? ((l) => layouts.push(l)),
    onError: opts.onError ?? ((m) => errors.push(m)),
    onFrame:
      opts.onFrame ?? ((f) => frames.push({ positions: f.positions.slice(), layout: f.layout, extra: f.extra })),
  })
  return {
    client,
    state,
    frames,
    layouts,
    errors,
    readyCount: () => ready,
    factoryRuns: () => factoryRuns,
    channel,
    mainPort,
    workerPort,
  }
}
