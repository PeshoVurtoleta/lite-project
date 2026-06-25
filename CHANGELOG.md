# Changelog

All notable changes to `@zakkster/lite-project` are documented here. The format
follows Keep a Changelog; this project adheres to semantic versioning.

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
