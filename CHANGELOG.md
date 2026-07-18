# Changelog

All notable changes to `@zakkster/lite-project` are documented here. The format
follows Keep a Changelog; this project adheres to semantic versioning.

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
