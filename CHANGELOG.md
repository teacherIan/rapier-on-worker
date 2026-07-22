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
- Hardening (from a 30-agent adversarial review of the initial extraction):
  `.js` ESM specifiers so native Node / NodeNext consumers load the package;
  `default` export condition for require(esm); throw-safe tick/publish
  (re-arm in finally, no buffer leak), throw-safe onFrame (RETURN in
  finally) and onLayout (pool seeds first); factory rejection surfaces as
  ERROR + `onError` with retryable INIT; duplicate INIT replays READY +
  layout instead of hanging a second client; `terminate()` posts STOP for
  terminate-less hosts; `TInput`/`TCommand` default to `never` so
  inference-only client call sites fail loudly; declaration maps + source
  maps shipped; regression tests for every confirmed finding (27 total).
