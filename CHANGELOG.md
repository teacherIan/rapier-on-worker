# Changelog

## 0.1.0

Initial release — the harness extracted from the Burr and Burton advisory
app's production soft-body worker:

- `steppedClock` — fixed-timestep accumulator (substep cap, spiral-of-death
  guard, resumable).
- Protocol — INIT / READY / COMMAND / LAYOUT / INIT_POOL / INPUT / FRAME /
  RETURN / START / STOP, with per-epoch transferable buffer pools and
  latest-wins input staging.
- `runSimWorker` / `attachSimWorker` — worker-side free-running loop, generic
  over app-defined init/input/command/layout/extra types.
- `createSimClient` — main-thread client: auto pool seeding, stale-frame
  drops, immediate buffer RETURN, pre-READY command queueing, latched
  setRunning, autoStart.
- Deterministic end-to-end tests over an in-memory channel with real
  structuredClone transfer semantics and faked timers.
