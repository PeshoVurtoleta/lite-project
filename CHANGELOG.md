# Changelog

All notable changes to `@zakkster/lite-project` are documented here. The format
follows Keep a Changelog; this project adheres to semantic versioning.

## Unreleased

### Fixed

- **Hot-path transient allocation (~40 B/op on `get`/`peek`/`set`).** The slot-
  creation closure lived inline in `slotFor`'s cold miss branch and captured
  `key`, so V8 allocated a context object on EVERY `slotFor` call -- hit or
  miss -- taxing the three hottest operations ~40 B/op each (measured: warm
  `get` 2,002,808 B over 50,000 ops). `peek` had the same defect twice over via
  inline `untrack(() => source.get(key))` closures, allocating even on the warm
  overlaid path that never takes the fallthrough; `reconcileAll` once per
  overlaid key. Fixes: slot creation hoisted to `_createSlot(key)` (context now
  allocated only on the cold miss), `peek` and `reconcileAll` ride the hoisted
  `_pk`/`_readSrc` scratch that `forEachPatch` already used. Measured after:
  0.04-0.15 B/op fixed noise across all warm windows. No API or behaviour
  change.

### Added

- **T6 Proof 0, the transient witness.** Warm `get` / `peek` / `set` /
  `set-clear toggle` / `get+set+clear` triangle windows are now hard-gated by
  the V8 new-space used-bytes delta over a GC-free 50,000-op window
  (<= 16,384 B total each). Every prior lane -- the gc-profiler heap gate, the
  retained-bytes bracket, the pool census -- is structurally blind to per-op
  garbage that never survives a collection, which is how the 40 B/op defect
  above passed the full gate. The GATE line now reports `transient=<n> B/op`
  (triangle; measured 0.131 B/op). Falsified: reverting the fix makes the gate
  exit 1 naming the window.

## [1.4.0] - 2026-09-05

### Added

- **`projectCRDT(map, opts?)`** -- a draft-overlay adapter for a
  `@zakkster/lite-crdt` LWW-Map (`doc.map(name)`). Unlike `projectRoom` (which
  wraps lite-room's **coarse** storage -- one `entries` signal, any change re-runs
  every projected key), an LWW-Map has **fine-grained** reactive `get(key)`, so
  `projectCRDT` is truly granular: overlaying or committing one cell never re-runs
  a consumer of another. `set(key, value)` stages a local draft (the CRDT is
  untouched); `commit(key?)` promotes drafts via `map.set` (one op per committed
  key -- LWW ops are commutative + idempotent, so N frames are semantically one);
  an auto-reconcile drops drafts the authoritative cell catches up to (a local
  echo or a remote `applyOp`) while leaving conflicts -- and a concurrent
  authoritative **delete** (reads as `undefined`) -- masked. The reconcile trigger
  is ONE effect that reads `dirtyCount()` (tracked -- re-derives the dependency set
  on every overlay-set transition) plus `map.get(k)` for each currently-overlaid
  key, then calls `reconcileAll(policy)`; it re-runs only on overlay-set
  transitions and on authoritative changes to overlaid keys. The map is consumed
  **structurally** (any `{ get, set }` with a fine-grained reactive `get`), so
  there is no hard dependency on lite-crdt, and the adapter never touches the doc,
  `map.store`, or the coarse reads (`keys`/`values`/`entries`/`size`).
- **`opts.transact`** -- an optional hook (e.g. `doc.transact`) that wraps both
  `commit` and `commitWhere` so an N-key burst coalesces into ONE ops frame + one
  change (measured: staging 3 keys emits 0 ops; committing emits 3 ops / 3 frames
  with no `transact`, 3 ops / **1** frame under `transact`). The branch is resolved
  once at construction; a supplied-but-non-function `transact` throws before any
  node is created. `LWWMapLike`, `ProjectCRDTOptions`, and the `projectCRDT`
  declaration added to `Project.d.ts`; `decisions/0003-project-crdt.md` records the
  design.

### Notes (recorded contracts, not bugs)

- **Read-only object wrapper.** lite-crdt's `get(key)` returns a deep **read-only
  wrapper** for object/array values (a different reference than the one passed to
  `set`, WeakMap-cached and stable across reads). So `confirmOnEcho` (`Object.is`)
  can **never** auto-confirm an object-valued draft over `projectCRDT`, even on a
  genuine local echo -- use a `{ ttl }` draft (the shipped self-heal) or a
  caller-supplied **structural** policy (whose reads pass through the wrapper
  transparently). A policy must never attempt to mutate the authoritative value it
  is handed for an object -- it is that read-only wrapper and lite-crdt throws
  `readonly`. Scalars confirm normally.
- **String-coercion key aliasing.** lite-crdt coerces every map key to a string,
  but projection slots are keyed by `PropertyKey`. Drafts on `5` and `"5"` are TWO
  projection slots that commit into ONE CRDT cell (last write wins), and
  `dirtyCount()` never reveals the collision -- stage under one key type. A
  `"__proto__"` map key is not usable in lite-crdt (`map.set` throws
  `CRDTError("misconfigured")`); the adapter does not wrap that policy -- a commit
  of a `"__proto__"` draft propagates the CRDT's own error with the draft still
  staged and `dirtyCount()` consistent (fail closed).
- **Dispose order.** `doc.dispose()` makes subsequent mutations silent no-ops, so a
  commit **after** the doc is disposed writes nothing yet still clears the drafts
  (an inherited dead-source data-loss class). Dispose the projection **before** the
  doc.

### Tests

- `test/crdt_test.mjs` (19 tests, real `@zakkster/lite-crdt` on the default
  registry): op-counter (stage/commit/transact frames), the wrapper pin (object
  draft after a genuine echo stays overlaid; a structural policy drops it), TTL
  heal over `projectCRDT`, numeric/symbol key-alias pins, `"__proto__"` commit
  fail-closed, granularity (a consumer of `get("b")` runs once across 10 commits to
  `"a"`; the reconcile effect does not fire on non-overlaid-key writes), missing-key
  draft (`from === undefined`; a remote `applyOp` re-runs the projected read),
  authoritative-delete conflict, dispose ordering, and the post-`doc.dispose()`
  commit hazard.
- Torture: `makeFakeMap` (a registry-parametric structural fake LWW-Map) drives new
  `T4` (echo/conflict/late-overlay per key), `T5` (`projectCRDT` fuzz oracle + the
  granularity law), `T6` (a warm echo-drop reconcile pass -- retains 0 B/call),
  and `T9` controls `(j)` (a coarse-read effect fails the granularity law) and
  `(k)` (a peek-only stale-deps effect misses a late-overlay echo). GATE unchanged:
  `leak=size 0/0 findings=0 warnings=0 | gc major=0 minor=0 maxMs=0.00 | retained=0.00 B/op growths=0`.

## [1.3.0] - 2026-09-05

### Added

- **Overlay TTL -- `set(key, value, { ttl })`.** Stage an overlay that
  auto-**reverts** at `now() + ttl` (a finite number > 0, in the clock's units):
  the draft is dropped and the source is **never** touched -- "the optimistic edit
  expired; fall back to authoritative". One re-armed platform timer per projection
  (each slot stores its own deadline; arm/fire do an `O(slots)` cold scan -- no
  side `Map`, no per-`set` allocation on the warm path). A bad `ttl`
  (`0`, `-1`, `NaN`, `Infinity`, `"5"`, `null`, ...) throws **before** staging. A
  re-set **with** `ttl` re-arms (an earlier deadline re-arms eagerly; a later one
  lets the armed timer fire spuriously and re-arm); a re-set **without** `ttl`
  cancels the pending expiry -- each `set` fully specifies its overlay's lifetime.
  Every transition to un-overlaid (`clear`, `commit(key)`, `commit()`, `revert`,
  a `reconcileAll` drop, `commitWhere`, `clearWhere`, and the fire itself) cancels
  that key's expiry, and `dispose()` cancels any pending handle.
- **Injectable clock -- `project(source, { now, setTimer, clearTimer })`.**
  All-or-none: supply all three (each a function) or none. A **mixed** clock is a
  `TypeError` (it would compute deadlines on one timeline and arm on another --
  fail closed). Defaults wrap `performance.now` / `setTimeout` / `clearTimeout`.
  Forwarded by `projectStore(store, opts?)`, `projectRoom(room, opts?)`, and
  `projectQuery(qc, key, opts?)` (the flat bag; `project` reads only the clock
  keys). `SetOptions`, `ProjectionClock`, and `ProjectOptions` added to
  `Project.d.ts`.
- **`Projection.commitWhere(pred)` / `Projection.clearWhere(pred)`** -- predicate-
  scoped partial save / discard. `pred(key, stagedValue)` (the `forEachOverlay`
  callback order, not `ReconcilePolicy`'s), visited in slots order, one reactive
  propagation each. `commitWhere` writes and clears only the matching overlays;
  `clearWhere` drops them with **zero** source writes. A throwing `pred` is
  non-atomic on the core handle (already-committed keys stay committed and
  `dirtyCount() === overlaidCount()`). `projectQuery` **overrides** `commitWhere`
  to keep the single-write law: one `setQueryData(key, prev => merge(prev,
  overlays))` for the matching fields, then the committed fields are cleared
  per-key -- the non-matching drafts survive (it does **not** reuse the `commit()`
  override's `revert()`, which would drop them too).

  **F-03 recorded.** `confirmOnEcho` is reference-equality (`Object.is`), so an
  object-valued draft can never echo-confirm against a structurally-equal source
  value of a different reference. The fix is a **caller-supplied** structural
  policy (`reconcileAll(policy)` and the `forEachPatch` skip param accept one);
  this library ships **no** deep-equal helper (a naive structural equal is a
  fail-open trap). The TTL is the shipped safety net: a stuck object draft
  self-heals on its deadline. Recorded in `decisions/0002-overlay-ttl.md`
  (dev-only; not shipped).

### Verified

- 30 new `test/ttl_test.mjs` cases (fire at / not-before the deadline, byte-
  identical source after a fire, re-arm + one-handle, plain re-set cancels,
  `null` / `{}` / `{policy}` bags behave as plain `set` and still cancel,
  cancellation at every ABSENT-transition site, the F-03 self-heal, the ttl +
  mixed-clock + non-object-`project`-opts `TypeError`s, `commitWhere` /
  `clearWhere` exact match + one
  propagation + throwing-pred consistency, a set-with-ttl honoured inside a fire
  subscriber, post-dispose inertness, and the four adapters incl. the
  `projectQuery` single-write `commitWhere`); **114 tests total**, `node --test`.
- Torture green (default seed):
  `leak=size 0/0 findings=0 warnings=0 | gc major=0 minor=0 maxMs=0.00 |
  alloc=n/a retained=0.00 B/op growths=0` (the binding channels are `major=0`,
  `retained=0.00`, `growths=0`; the `alloc=` per-op bracket prints as-is, `n/a`
  when the profiler's heap window was inconclusive). T4 gains the TTL door
  (deterministic fake clock: expire / not-before / re-arm / cancel + the F-03
  object heal). T6 gains Proof 5 -- warm ttl re-set + `commitWhere` + `clearWhere`
  under an injected no-op clock retain `0 B/call` at `maxBytesPerCall 0` (the warm
  no-ttl triangle passes the P0 gates unchanged). T7 gains a 1000-TTL sub-soak:
  `maxOutstanding() === 1` at every instant, `0` after the drain fire and after
  `dispose()`, tracker back to `size()===0`. T9 gains controls (h) a default-clock
  projection tripping the deterministic expiry assertion, and (i) a leaky per-key
  timer tripping the one-handle bound.

## [1.2.0] - 2026-09-05

### Added

- **`Projection.forEachPatch(fn, skip?)`** -- emit the staged drafts as a
  `(key, from, to)` stream, where `from` is the **untracked** current source
  value and `to` the staged overlay. Read-only and untracked: it touches neither
  the source nor the overlays and subscribes the caller to nothing, so it is safe
  inside an effect. Visits exactly the overlaid keys, in `forEachOverlay` order,
  with a **zero-allocation** per-key body (the source read is hoisted through one
  closure per projection, never one per key). The optional `skip` reuses the
  `ReconcilePolicy` shape `(from, to, key) => boolean` -- pass `confirmOnEcho` to
  drop unchanged drafts. A throwing `source.get` propagates on the offending key
  with the overlay bag intact (no writes happen anywhere in the call).
- **`Projection.toPatch(skip?)`** -- the cold convenience that materializes the
  same stream as `[{ key, from, to }, ...]` (same visit set, order, and values).
  The per-key record is this form's documented allocation; reach for
  `forEachPatch` when you need the zero-alloc callback. Both methods are present
  on the `projectStore` / `projectRoom` / `projectQuery` handles (for
  `projectQuery`, `from` is the cached record's field value; for `projectRoom`,
  `room.storage.get`).
- **`Patch<K, V>`** interface (`{ key, from, to }`) exported from `Project.d.ts`.

  **The decision -- unchanged drafts are emitted by default.** An overlaid key is
  emitted whether or not `Object.is(from, to)`. This keeps the visit set
  definitionally equal to `forEachOverlay`, `dirtyCount()`, and `commit()`'s write
  set, so `toPatch().length === dirtyCount()` always holds; a patch consumer is a
  protocol (an LWW-Map op, a CRDT timestamp bump, an HTTP PATCH field), not a diff
  viewer, so dropping an unchanged key would be silent data loss one layer out.
  Callers who want the filter pass `forEachPatch(fn, confirmOnEcho)`. Recorded in
  `decisions/0001-patch-emission.md` (dev-only; not shipped).

### Verified

- 17 new `test/patch_test.mjs` cases (visit-set exactness + order, from/to vs
  source and overlay, `toPatch()` == the callback stream, the emit-by-default and
  echo-skip pins, the tracking contract, `__proto__` / symbol / numeric keys,
  `undefined` / `NaN` / `-0` under `Object.is`, fail-closed on a throwing
  `source.get`, patch-apply == commit, and all four adapter handles); **84 tests
  total**, `node --test`.
- Torture green (default seed):
  `leak=size 0/0 findings=0 warnings=0 | gc major=0 minor=0 maxMs=0.00 |
  alloc=n/a retained=0.00 B/op growths=0`. T5 gains the metamorphic law (the
  emitted patch applied to a fresh source copy == `commit()` into it, across the
  fuzz corpus incl. object drafts). T6 gains Proof 4 -- `forEachPatch` over a
  warm overlaid set passes both the heap gate (`maxMajor 0`, `maxPauseMs 4`,
  `maxArrayBuffersGrowth 0`) and the zero-retention gate (`maxBytesPerCall 0`).
  T9 gains control (g): a per-visit-allocating emitter body demonstrably trips the
  retained-alloc gate through the same helper.

## [1.1.1] - 2026-09-03

### Added

- **`VERSION`** export from `Project.js` (declared in `Project.d.ts`), kept in
  exact sync with `package.json`, so a consumer can read the shipped version at
  runtime.
- Gated torture harness under `test/torture/` (dev-only; not shipped). Seven
  tiers run strictly sequentially behind `node --expose-gc test/torture.mjs`:
  T0 metamorphic laws, T1 degenerate inputs, T4 reconcile door, T5 oracle fuzz,
  T6 zero-alloc gate, T7 retention soak, T9 controls. Gate RULES:
  `maxMajor 0`, `maxPauseMs 4`, `maxArrayBuffersGrowth 0` under `stabilize:"deep"`.
  Witnessed on a green run (default seed):
  `leak=size 0/0 findings=0 warnings=0 | gc major=0 minor=0 maxMs=0.00 |
  retained=0.00 B/op growths=0`
  (the `alloc=` per-op heap-bracket reading prints as-is, `n/a` when
  inconclusive; the binding alloc gates are `checkNoGc`, the zero-retention
  gate below, and the structural deltas below).
  The get/set/clear triangle on warmed keys leaves `poolGrowths` and
  `totalAllocations` deltas both 0 over 200k toggles; 4096 build/tear-down cycles
  return the leak tracker to `size()===0`; `prune()` reclaims >= 19990 of 20000
  unbounded-read slots.
- Retained-allocation gate (`measureAllocs` + `checkAllocs` with
  `maxBytesPerCall: 0`, the profiler's zero-retention assertion): the warmed
  get/set/clear triangle retains 0 B/call (min over 8 batches), catching
  arbitrary JS-object retention that the asynchronously-delivered `gc.major`
  count cannot see; an unsettled or inconclusive reading fails the gate.

### Changed

- Peer dependency floor is now `@zakkster/lite-signal ^1.5.0` (was a pinned
  preview build). No behaviour change: 1.5.0 is the current stable line and
  supplies every surface this package uses (`batch` 1.0.0, `hasObservers` 1.1.4,
  `createRoot` 1.5.0).

## [1.1.0] - 2026-07-16

### Added

- **`projectQuery(qc, key, opts?)`** — a library adapter projecting ONE
  [`@zakkster/lite-query`](https://www.npmjs.com/package/@zakkster/lite-query)
  entry's data object as a draft overlay whose projected keys are the **fields**
  of that record. Stage optimistic field edits with `set(field, v)`, then
  `commit()` promotes every staged field into the cache as a **single**
  `setQueryData(key, prev => merge(prev, overlays))` write (one cache mutation,
  one broadcast) — `commit(field)` writes just one. Options:
  - `data` — the query's reactive data accessor (e.g. `query.data`). Supplied,
    projected reads track the cache and an auto-reconcile drops drafts the
    authoritative record catches up to (echo policy) while leaving conflicting
    values masked, exactly as in `projectRoom`. Omitted, the adapter degrades to
    a non-reactive `getQueryData` snapshot with no auto-reconcile.
  - `policy` — reconciliation policy (default `confirmOnEcho`).
  - `merge` — how overlays fold into the record (default shallow spread
    `{ ...prev, ...overlays }`; `prev` may be nullish, seeding a fresh record).

  The query client is consumed **structurally** (any object exposing
  `getQueryData` / `setQueryData`), so this adds no hard dependency on
  lite-query. The returned handle's `dispose()` also stops the reconcile effect.
  No changes to the core or the existing adapters.

- **`Projection.prune()`** — bounded-keyspace reclamation. A slot (one overlay
  signal + one projected computed) is created by the first **read** of a key and
  retained until `dispose()`, because its computed may still have subscribers —
  so neither `commit()` nor `revert()` gives any of it back. Over a large or
  unbounded keyspace (a virtualised list, a record whose fields churn, a
  projection driven by user input) that is real growth: 20,000 reads retained
  60,000 nodes. `prune()` releases only the slots that are **both** un-overlaid
  (nothing staged to lose) and unobserved (no live consumer subscribed to the
  projected read), so it can never dispose a computed out from under a
  subscriber; a pruned key rebuilds transparently on its next read. Returns the
  number of slots freed. Cold path — call it on a viewport change or after a
  commit, not per frame. `O(slots)`. Requires `hasObservers` from the registry;
  a custom registry without it gets a `prune()` that reclaims nothing and
  returns `0` rather than a crash. Available on every projection handle,
  including the `projectStore` / `projectRoom` / `projectQuery` wrappers.

### Fixed

Found by the adversarial suite below during the 1.1.0 prepublish review. Every
one of these failed **silently**: `commit()` returned normally and `dirtyCount()`
fell to 0 while the value never reached the record.

- **A draft field named `__proto__` was dropped — and could inject fields.** The
  default merge built the record with `out[k] = v`, which for `__proto__`
  retargets the prototype instead of creating an own key, so the field vanished.
  Worse, staging that draft set the overlay bag's own prototype, and the merge's
  `for...in` then enumerated *that object's* keys — so committing a `__proto__`
  draft injected its contents as top-level fields of the record. The overlay bag
  is now null-prototype, keys are defined rather than assigned, and iteration is
  own-keys only.
- **Symbol-keyed drafts evaporated on commit.** Projection keys are
  `PropertyKey` and slots live in a `Map`, so a symbol-keyed draft staged fine
  and reported dirty — then `for...in` skipped it and the commit reported
  success for a value that never landed. The merge now includes own enumerable
  symbols.
- **Inherited properties leaked into the record.** `for...in` walked `prev`'s
  prototype chain, absorbing inherited properties into the committed record as
  own fields. Own-keys only now.

### Verified

- 17 new adversarial tests (`test/torture_test.mjs`); **65 tests total**,
  `node --test`. `prune()` is exercised for reclamation, for refusing to drop
  observed or overlaid slots, and for transparent rebuild after a prune.

### Torture (opt-in: `npm run test:torture`)

- `test/torture_test.mjs` — adversarial regression suite, part of the normal
  `npm test`. Each case pins a defect from the list above, or a limit that is
  deliberately **not** fixed and must not drift silently. Node-count tests
  install a fixed-ceiling registry over a node-free source, so the
  projection's own accounting is readable.
- `bench/torture/overlay-fuzzer.mjs` — seeded, oracle-checked fuzz: projectQuery
  set/clear/commit(field)/commit-all/revert plus external cache writes (driving
  auto-reconcile), asserting the view + cache track an overlay/record oracle and
  every commit is a single write; plus a core project() overlay/commit/revert
  fuzz over a reactive source. Scale with `TORTURE_SCALE`. Dev-only; not in
  `files[]`.

## [1.0.0] - 2026-06-25

First stable release. Zero-GC projections for `@zakkster/lite-signal`.

### Added

- **`project(source)`** — a granular, derived, non-mutating draft overlay over
  any keyed reactive source. Each touched key owns one overlay signal + one
  projected computed, created lazily inside `createRoot` (so they outlive the
  consumer that first reads the key) and recycled by `dispose()`.
  - `get` / `set` / `clear` / `commit` / `revert`, plus `commit(key)` for a
    partial (single-key) commit
  - **reactive dirty state:** `dirtyCount()` / `isDirty()` are tracked (back an
    "unsaved changes" badge or a Save button with no polling), backed by one
    fixed signal per projection whose updates are allocation-free
  - `isOverlaid` / `overlaidCount` / `peek` (untracked diagnostics)
  - `forEachOverlay` (iterate overlaid keys) and `reconcileAll(policy?)`
    (full-snapshot reconciliation)
- **The three properties**, each test-covered: granular (overlaying A never
  re-runs a consumer of B), derived (revert / source changes flow through), and
  non-mutating with **masking** (a source change under an overlay is suppressed
  by the engine's `Object.is` short-circuit — the optimistic value is stable
  under source noise).
- **`createProjector(reg)`** — bind the primitives to any lite-signal registry
  (default namespace, or an isolated `createRegistry` graph).
- **`keyedStore(initial?)`** — a minimal built-in keyed reactive source.
- **Reconciliation:** `confirmOnEcho` (default echo policy) and
  `makeReconciler(view, policy?)` (per-key event handler for sources with an
  incoming-update channel).
- **Source adapters:** `fromAccessors`, `fromProxy`.
- **Library adapters:** `projectStore` (per-key-granular drafts over
  `@zakkster/lite-store`, commit-writes-through) and `projectRoom`
  (presentation-only optimistic drafts over a `@zakkster/lite-room` LWW-Map;
  subscribes through the coarse `entries` signal and auto-reconciles, with
  `commit()` promoting via `room.storage.set`).

### Verified

- Zero steady-state allocation: 200k overlay toggles on warmed keys leave
  `poolGrowths` and `totalAllocations` flat. Documented non-claim: the first
  touch of a new key allocates its slot + two pooled nodes.
- 20 tests under `node:test` (core projection, integration helpers, and the
  store / room adapters against faithful stand-ins of their documented surfaces).

### Notes

- Peer dependency `@zakkster/lite-signal` `^1.5.0` (requires `createRoot`).
- Derived-shape lenses (`select` / `filter` / `map`) are planned for a future
  minor on the same per-key-computed substrate.

[1.0.0]: https://github.com/PeshoVurtoleta/lite-project/releases/tag/v1.0.0
