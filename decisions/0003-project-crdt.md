# 0003 -- projectCRDT: fine-grained drafts over a lite-crdt LWW-Map

Date: 2026-09-05
Status: accepted (v1.4.0)

Context: `projectRoom` wraps lite-room's COARSE storage -- a single `entries`
signal, so any authoritative change re-evaluates every projected key.
`@zakkster/lite-crdt` 2.0.0's LWW-Map (`doc.map(name)`) exposes a FINE-GRAINED
reactive `get(key)` (an effect reading `map.get("a")` re-runs on a write to `"a"`,
not on a write to `"b"`; probed local AND through `doc.applyOp`). A per-key adapter
therefore gives true granularity: overlaying or committing one cell never re-runs a
consumer of another. `projectCRDT` is the fourth adapter in the optimistic-updates
story (store / room / query / crdt). It is presentation-only -- the projection
never joins the merge.

## Decision -- a structural map handle, no doc

The adapter takes the MAP handle structurally
(`source = { get: (k) => map.get(k), set: (k, v) => map.set(k, v) }`), not the
doc. lite-crdt binds the DEFAULT lite-signal registry through its own import (the
same adapter class as store/room/query), so the fine-grained `get` carries
reconciliation through the reactive engine itself -- no event wiring, no hard
dependency, and it mirrors `projectQuery`'s `qc` structural pattern. `map.set`
throws propagate unwrapped (fail closed). The adapter NEVER touches `map.store`
(read-only, throws on write) or the coarse reads (`keys`/`values`/`entries`/
`size`).

## Decision -- a dirtySig-tracked reconcile effect

ONE effect that (a) reads `view.dirtyCount()` TRACKED, (b) reads `map.get(k)`
TRACKED for each currently-overlaid key (via `view.forEachOverlay`, whose overlay
side peeks untracked), then (c) calls `view.reconcileAll(policy)` (its internal
source reads are untracked, so it adds no deps). `dirtySig` is written only on
overlay presence transitions, so reading it is what RE-DERIVES the dependency set
exactly when the overlaid key set changes; between transitions the effect tracks
precisely the source cells of the overlaid keys. It re-runs on overlay-set
transitions and on authoritative changes to OVERLAID keys -- granular, no doc
access, no events. The `_trackSrc` callback is hoisted once per adapter (never a
per-run arrow).

## Rejected -- one effect per key

O(keys) allocation: an effect handle per touched key is exactly the shape the
zero-alloc gate forbids, and it scales with the keyspace. The single tracked effect
is O(1) handles.

## Rejected -- doc.on('change')

Doc-COARSE (fires on any collection's change) and drags the doc -- plus event
plumbing and a disposer -- into the adapter's surface. The granular reactive `get`
makes it unnecessary.

## The bounded extra pass (recorded tradeoff, not a loop)

`reconcileAll` writes `dirtySig` when it drops an overlay, and the effect reads
`dirtySig`, so a confirming echo costs ONE extra effect pass that settles at the
fixed point: the second pass finds nothing new to drop (`reconcileAll` is guarded
by `if (dropped)`), writes no `dirtySig`, and terminates. `reconcileAll`'s internal
reads are untracked, so it adds no dependency and cannot self-trigger. Similarly a
TTL fire writes `s.ov.set(ABSENT)` + `dirtySig`; the effect re-runs once over the
SMALLER overlay set (the expired key's `map.get` dep is dropped) and terminates.

## The read-only wrapper contract, and why Object.is cannot confirm objects

lite-crdt's `get(key)` returns a deep READ-ONLY WRAPPER for object/array values --
`map.get(k) !== the reference passed to set(k, v)` (WeakMap-cached, stable across
reads; probed). So `confirmOnEcho` (`Object.is`) can NEVER auto-confirm an
OBJECT-valued draft over `projectCRDT`, even on a genuine local echo. Scalars
confirm normally. The heal is a `{ ttl }` draft (0002's self-heal) or a
caller-supplied STRUCTURAL policy, whose reads pass through the wrapper
transparently. A policy must NEVER attempt to mutate the authoritative argument for
an object value -- it is the read-only wrapper and lite-crdt throws `readonly`. A
concurrent authoritative DELETE reads as `undefined`, which no policy confirms
against a present draft, so a delete-vs-draft conflict stays masked; the TTL heals.

## String-coercion key aliasing (caller hazard)

lite-crdt coerces every map key to a string, but projection slots are keyed by
`PropertyKey`. Drafts on `5` and `"5"` are TWO projection slots that commit into
ONE CRDT cell -- last write wins, and `dirtyCount()` never reveals it. A symbol
key `String()`-coerces (e.g. into `"Symbol(s)"`); a `"__proto__"` map key is
unusable in lite-crdt (`map.set` throws `CRDTError("misconfigured")`) -- the
adapter does not wrap that policy, so a commit propagates the CRDT's own error with
the draft still staged and `dirtyCount()` consistent. Documented, never wrapped:
the CRDT door owns key policy.

## transact adopted -- opt-in, cold

`commit()`/`commitWhere()` emit N ops = N frames (one `map.set` per key); LWW ops
are commutative + idempotent, so N frames are semantically one (there is NO
single-write law here, unlike `projectQuery`). But a caller holding a doc cannot
get one frame per burst without a hook. `opts.transact` (e.g. `doc.transact`) wraps
BOTH `commit` and `commitWhere` so a burst coalesces into ONE ops frame + one
change. The hook is four lines, cold, opt-in; the branch is resolved once at
construction (no per-call test), and a supplied-but-non-function `transact` throws
BEFORE any node is created (fail closed).

## Dispose order (inherited dead-source class)

`doc.dispose()` makes subsequent mutations SILENT no-ops, but `view.commit` clears
the draft unconditionally -- so a commit after the doc is disposed writes nothing
yet still clears the drafts (optimistic data loss). Dispose the PROJECTION before
the doc. The adapter's own `dispose()` stops the reconcile effect then disposes the
view (the `projectRoom` precedent).

## Consequences and what qa falsifies

- Stage 3 keys: op events = 0. Commit: 3 ops / 3 frames; under `transact`: 3 ops /
  1 frame.
- A consumer of `view.get("b")` runs exactly once across 10 commits to `"a"`; the
  reconcile effect does not fire on non-overlaid-key authoritative writes. Controls
  (j) a coarse-read effect and (k) a peek-only stale-deps effect both fail when
  inverted.
- The reconcile effect's warm echo-drop steady state retains 0 B/call (T6,
  check-only); 4096 build/dispose cycles leave the leak witness 0/0; `dispose()`
  stops the effect.
- The wrapper pin: an object draft after a genuine local echo stays overlaid; with
  `{ ttl: 50 }` + `advance(50)` it heals.
