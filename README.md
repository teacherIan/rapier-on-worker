# rapier-on-worker

Run your physics simulation in a Web Worker without giving up 60 fps hand-off,
clean pause/resume, or layout changes mid-flight. This package is the **harness**
— a free-running fixed-timestep loop, a transferable frame-buffer pool, and an
epoch-guarded message protocol — extracted from a production PIXI + Rapier app
where it drives ~600 soft-body vertices and ~1,200 spring joints off the main
thread. **You bring the simulation**; the harness never imports a physics
engine, so it works with Rapier 2D/3D, any other engine, or plain math.

```
main thread                          worker
───────────                          ──────
createSimClient(...)  ── INIT ──▶    runSimWorker(factory)
                      ◀─ READY ──    factory() resolved (WASM init done)
sendCommand(...)      ── COMMAND ─▶  sim.command() → new layout?
                      ◀─ LAYOUT ──   epoch++, pool dropped
(pool auto-seeded)    ── INIT_POOL ▶ 3 transferable buffers
sendInput(...) 60Hz   ── INPUT ──▶   staged, latest-wins
onFrame(frame)        ◀─ FRAME ───   filled buffer, transferred
(copy, then auto)     ── RETURN ──▶  buffer back in the pool
```

## Why this shape

- **The worker is the clock.** It self-paces a fixed-timestep accumulator
  (Fiedler's "Fix Your Timestep": substep cap + spiral-of-death guard) and
  steps whether or not the main thread is keeping up. A busy main thread drops
  *frames*, never *simulation time*.
- **Transferables, not SharedArrayBuffer.** Every per-frame payload is a
  `Float32Array` buffer moved by ownership transfer — zero copy, no message
  queue growth (the pool is the backpressure), and **no COOP/COEP headers**.
  Your app stays non-cross-origin-isolated: popup auth flows, cross-origin
  iframes, and plain static hosting (GitHub Pages included) all keep working.
- **No worker file in this package.** You author your own worker module and
  call `runSimWorker` from it. That keeps `new Worker(new URL(...))` in *your*
  app where every bundler handles it natively — none of the
  worker-inside-a-dependency resolution pitfalls exist here.
- **Epochs make layout changes safe.** When your sim's frame shape changes
  (bodies added/removed), the worker bumps an epoch, drops its pool, and
  announces the new layout; the client re-seeds automatically. Frames and
  buffer returns from the old epoch are dropped instead of mis-read; a stale
  input is still delivered, flagged `epochOk=false`, so your sim can keep its
  layout-independent fields and ignore the positional ones.

## Install

```sh
npm i rapier-on-worker
```

No runtime dependencies, no peer dependencies.

## Use

**1. Your worker file** (`sim.worker.ts`) — plain app code; import your engine
here (with Rapier, prefer `@dimforge/rapier2d-compat` inside workers — its WASM
is embedded, so nothing needs URL resolution):

```ts
import { runSimWorker, type WorkerSim } from 'rapier-on-worker'
import RAPIER from '@dimforge/rapier2d-compat'

interface Init { width: number; height: number }
interface Input { pointerX: number; pointerY: number }
type Command = { kind: 'spawn'; count: number } | { kind: 'resize'; width: number; height: number }
interface Layout { capacity: number }
interface Extra { liveCount: number }

runSimWorker<Init, Input, Command, Layout, Extra>(async (init) => {
  await RAPIER.init()
  const world = new RAPIER.World({ x: 0, y: 620 })
  const bodies: RAPIER.RigidBody[] = []
  let staged: Input | null = null
  const capacity = 2000

  const sim: WorkerSim<Input, Command, Layout, Extra> = {
    command(cmd) {
      if (cmd.kind === 'spawn') {
        // ...create cmd.count bodies...
        return null // capacity-sized frames: growth never changes the shape
      }
      return null // resize moves walls, frame shape unchanged
    },
    beginTick(input, epochOk) {
      staged = input // epochOk matters only for layout-order-positional fields
    },
    step(dt) {
      // apply staged input as forces/kinematic targets, then:
      world.timestep = dt
      world.step()
    },
    fillFrame(out) {
      for (let i = 0; i < bodies.length; i += 1) {
        const p = bodies[i].translation()
        out[i * 3] = p.x
        out[i * 3 + 1] = p.y
        out[i * 3 + 2] = bodies[i].rotation()
      }
      return { extra: { liveCount: bodies.length } }
    },
  }
  // Announce the capacity-sized layout up front: one epoch, forever.
  return { sim, layout: { layout: { capacity }, frameFloats: capacity * 3 } }
})
```

**2. Your main-thread code:**

```ts
import { createSimClient } from 'rapier-on-worker'

const client = createSimClient<Init, Input, Command, Layout, Extra>({
  worker: new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  init: { width: innerWidth, height: innerHeight },
  onFrame: ({ positions, extra }) => {
    // positions is only valid inside this callback (the buffer is recycled
    // the moment you return) — copy what you keep, or write straight into
    // your sprites here.
    for (let i = 0; i < (extra?.liveCount ?? 0); i += 1) {
      sprites[i].position.set(positions[i * 3], positions[i * 3 + 1])
      sprites[i].rotation = positions[i * 3 + 2]
    }
  },
})

client.sendCommand({ kind: 'spawn', count: 100 })
addEventListener('pointermove', /* throttle to rAF, then */ (e) => {
  client.sendInput({ pointerX: e.clientX, pointerY: e.clientY })
})
document.addEventListener('visibilitychange', () => client.setRunning(!document.hidden))
```

## Patterns

**Growing sims (spawners).** Don't re-announce a layout per spawn — that would
churn epochs and reallocate the pool constantly. Size `frameFloats` to your
**capacity** once and carry the live count in `extra`. One epoch for the whole
run.

**Soft bodies / custom force passes.** Your `step(dt)` owns everything between
fixed steps — apply spring impulses, area preservation, whatever your sim
needs. The harness doesn't know what a body is.

**Pointer drag.** Send the pointer *target* in `sendInput` and let the sim
chase it with a kinematic body or a spring each `step`. The one-frame hop is
invisible behind the spring; never try to set positions from the main thread.

**Stale input and `epochOk`.** Inputs are stamped with the epoch they were sent
under. After a layout change, an in-flight input's *positional* data (arrays
in layout order) is meaningless — but scalar fields (a pointer position) are
still fine. `beginTick(input, epochOk)` hands your sim both, and your sim
decides which fields survive a stale epoch.

**Pause on hidden tabs.** Browsers throttle page timers in background tabs but
generally let dedicated-worker timers run; call
`client.setRunning(!document.hidden)` so a hidden tab doesn't burn a core. On
resume, the harness resets the accumulator (no catch-up burst) and calls your
sim's `onStart` so input-delta baselines re-seed.

**Selective pause (multiple worlds in one sim).** START/STOP is whole-worker.
A sim hosting several independent worlds (four game lanes, say) that need
per-world freezing should model that as an app command — `{ kind: 'freeze',
world: 2 }` — and simply skip that world in `step`. That's the idiomatic
bring-your-own-sim shape; don't reach for one worker per world just to pause
them separately.

**Factory failure.** If your factory throws or rejects (a WASM fetch on a bad
network), the worker posts an ERROR and the client's `onError` fires — READY
never comes, and a fresh client (or page retry) may re-INIT. Wire `onError`
to your app's failure UI; without it the only trace is the worker console.

**Vite dev note.** Because the worker file is *yours*, no special config is
needed in the common case. If you ever see the worker fail to resolve in dev
while depending on a package that itself contains `new Worker(...)` calls,
add that package to `optimizeDeps.exclude` — not needed for this one.

## API

- `runSimWorker(factory, opts?)` / `attachSimWorker(ctx, factory, opts?)` —
  worker side. `factory(init)` (async ok) returns `{ sim, layout? }`.
  Options: `fixedDt` (1/60), `targetMs` (16.7), `maxSubsteps` (2),
  `spiralClamp` (0.25), `poolSize` (3).
- `createSimClient(options)` — main side. Options: `worker`, `init`,
  `onFrame`, `onReady?`, `onLayout?`, `onError?`, `poolSize?`, `autoStart?`
  (true). Returns `{ ready, layout, sendInput, sendCommand, setRunning,
  terminate }`. Pass all five type arguments explicitly (as in the quickstart):
  `TInput`/`TCommand` can't be inferred from the options and default to
  `never`, so an inference-only call site fails loudly instead of silently
  accepting anything. `layout()` is null until the first LAYOUT arrives —
  guard early frames (`client.layout()?.order ?? []`). One client per worker:
  the client owns `onmessage`.
- `WorkerSim` — your contract: `command`, `beginTick`, `step`, `fillFrame`,
  `onStart?`.
- `steppedClock(step, { fixedDt, maxSubsteps, spiralClamp })` — the fixed-step
  accumulator, exported standalone (it's just as useful on a main thread).

## Provenance

Extracted from the Burr and Burton advisory app's competition celebration,
where the identical protocol has been stepping a 24-blob soft-body race
(~576 rigid bodies, ~1,152 spring joints, 60 Hz) in a worker in production.
The sibling package [bubble-rapier-text](https://github.com/teacherIan/bubble-rapier-text)
renders physics bubble letters; this one keeps whatever you render honest
under load.

## License

MIT © Ian Malloy
