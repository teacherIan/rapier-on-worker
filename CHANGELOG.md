# Changelog

## 0.1.1

Stability fixes from a multi-agent audit:

- **Pool starvation on a post throw (the important one).** `publish()` returned
  the popped frame buffer to the pool when `fillFrame` threw, but not when the
  `postMessage` itself threw — a duplicate transfer buffer (a sim that lists
  `out.buffer`, which is the frame buffer) or a non-cloneable `extra` leaked one
  buffer per bad tick and starved the pool for good, silently freezing the
  render. The post is now inside the same guard, and the transfer list drops any
  entry that is the frame buffer.
- `terminate()` nulls `worker.onmessage`, releasing the handler closure (which
  captures `onFrame` → the render scene) and preventing a stale call on a
  port-backed host that outlives the client.
- The client message handler ignores null / non-object messages, symmetric with
  the worker.
- A sim factory that returns a malformed setup (e.g. a forgotten `return`) now
  posts `ERROR` instead of hanging the client forever.
- On `READY`, the client drives the pump explicitly to the wanted state
  (`START` or `STOP`), so a second client re-attaching to a kept worker whose
  pump the previous client left running can stop it.
- README: removed a phantom `.order` field from the client-API note.

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
