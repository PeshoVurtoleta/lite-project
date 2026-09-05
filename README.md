# @zakkster/lite-project

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-project.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-project)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Hot%20path-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-project?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-project)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-project?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-project)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-project?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-project)
[![lite-signal peer](https://img.shields.io/badge/peer-lite--signal-blue?style=for-the-badge)](https://github.com/PeshoVurtoleta/lite-signal)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

**Zero-GC projections for [@zakkster/lite-signal](https://www.npmjs.com/package/@zakkster/lite-signal).**

A *projection* is a granular, derived, **non-mutating** reactive view over a keyed source — a lens that carries ephemeral overlays (optimistic edits, drafts, "pending" state) without touching the underlying data, then `commit()`s those overlays into the source or `revert()`s them. It is the "Beyond Signals" projection primitive, built on lite-signal's node pool so the steady state allocates nothing the engine can avoid.

```mermaid
flowchart LR
  subgraph per-key
    O["overlay signal<br/>(ABSENT | value)"]
    S["source cell"]
    P{{"projected computed<br/>overlay ?? source"}}
    O -- tracked --> P
    S -- tracked --> P
  end
  P --> C["consumer<br/>(effect / UI)"]
  C -. "set(key, v)" .-> O
  O -. "commit()" .-> S
  S -. "clear() / reconcile" .-> O
```

Each touched key owns **one overlay signal + one projected computed**. Reading a key tracks its effective value (overlay if staged, else source); overlaying key `A` never re-runs a consumer of key `B`.

---

## Install

```sh
npm i @zakkster/lite-project
```

Peer dependency: `@zakkster/lite-signal` `^1.5.0` (the projection relies on `createRoot`, which landed in 1.5.0).

## Quick start

```js
import { project, keyedStore } from "@zakkster/lite-project";
import { effect } from "@zakkster/lite-signal";

const store = keyedStore({ title: "untitled" });   // any reactive get/set source
const draft = project(store);

effect(() => console.log("showing:", draft.get("title")));   // "untitled"

draft.set("title", "Draft name");   // optimistic: prints "Draft name"
store.get("title");                 // still "untitled" -- source untouched

draft.commit();                     // writes the overlay into the store
draft.isOverlaid("title");          // false
```

## The three properties

- **granular** — reading key `K` subscribes only to `K`'s effective value (each projected key is its own computed). Overlaying one key never re-runs another key's consumer.
- **derived** — `get(key)` is reactive: it tracks **both** the overlay and the source cell, so a `revert()` (or a source change after a revert) flows through.
- **non-mutating** — `set(key, v)` writes an overlay **only**; the source is untouched until `commit()`. While a key is overlaid, a source change to it is *masked* (the projected value stays the overlay) and, thanks to the engine's `Object.is` short-circuit, does **not** churn downstream consumers. The optimistic value is stable under source noise — no flicker.

## Reactive dirty state

`dirtyCount()` and `isDirty()` are **tracked** — read them in an effect/computed to drive an "unsaved changes" badge or a Save button with no polling. (`isOverlaid` / `overlaidCount` stay untracked for diagnostic reads that must not subscribe.)

```js
effect(() => { saveButton.disabled = !draft.isDirty(); });   // re-runs only on clean<->dirty flips

draft.set("title", "x");   // -> isDirty() true, button enabled
draft.commit("title");     // commit just one field; -> back to clean
```

Updating the dirty count is allocation-free (a single fixed signal per projection, bumped on each presence transition), so the zero-GC property holds even with the Save effect subscribed.

## Zero-GC

In steady state the projection allocates nothing: toggling an overlay on a key you have already touched reuses its pooled nodes (verified — 200k overlay toggles on warmed keys leave `poolGrowths` and `totalAllocations` flat). The honest non-claim: the *first* touch of a **new** key allocates a slot record, a Map entry, and two pooled nodes (one overlay signal, one projected computed). Warm the keys you churn.

**Slots outlive `commit()` and `revert()`.** A slot is created by the first *read* of a key and retained until `dispose()`, because its projected computed may still have subscribers — clearing an overlay does not release it. Over a bounded keyspace (a form, a settings panel) that is exactly the point: the nodes are there to be reused. Over a large or unbounded one — a virtualised list, a record whose fields churn, a projection driven by user input — it is real growth that neither `commit()` nor `revert()` gives back.

`prune()` <sub>1.1</sub> is the reclamation path. It releases only slots that are **both** un-overlaid (no staged value to lose) and unobserved (no live consumer subscribed to the projected read), so it can never pull a computed out from under a subscriber; a pruned key rebuilds transparently on its next read. It is a cold path — call it on a viewport change or after a commit, never per frame — and it is `O(slots)`. It needs `hasObservers` from the registry to tell an unused slot from a watched one; a custom registry without it gets a `prune()` that safely reclaims nothing and returns `0`.

## API

### `createProjector(reg) -> { project, keyedStore }`

Bind the primitives to a lite-signal registry. Pass the default namespace for normal use, or a `createRegistry({...})` result for an isolated graph (tests, the zero-GC gate). The package also exports `project` and `keyedStore` pre-bound to the default registry for the common case.

### `project(source, opts?) -> Projection`

`source` is any object with a reactive `get(key)` and a `set(key, value)`. `opts` is an optional injectable clock for overlay TTL -- `{ now, setTimer, clearTimer }`, all-or-none (a mixed clock is a `TypeError`); it defaults to `performance.now` / `setTimeout` / `clearTimeout`. Returns a handle:

| method | description |
| --- | --- |
| `get(key)` | reactive: overlay value if staged, else the source value |
| `set(key, value, opts?)` | stage an **ephemeral** overlay (source untouched); pass `{ ttl }` to auto-revert it <sub>1.3</sub> |
| `clear(key)` | drop one key's overlay (revert that key) |
| `commit(key?)` | write one key's overlay (or, with no arg, all) into the source, then clear |
| `commitWhere(pred)` | write + clear only the overlays where `pred(key, value)` is true <sub>1.3</sub> |
| `clearWhere(pred)` | drop only the overlays where `pred(key, value)` is true (source untouched) <sub>1.3</sub> |
| `revert()` | drop all overlays |
| `dirtyCount()` | **tracked / reactive**: count of staged overlays — wire a Save badge to it |
| `isDirty()` | **tracked / reactive**: `dirtyCount() > 0` |
| `isOverlaid(key)` | untracked diagnostic: is the key overlaid? |
| `overlaidCount()` | untracked diagnostic: number of overlaid keys |
| `peek(key)` | untracked effective read (no subscribe) |
| `forEachOverlay(fn)` | iterate overlaid keys + values (untracked) |
| `forEachPatch(fn, skip?)` | emit staged drafts as a `(key, from, to)` stream (untracked, read-only, zero-alloc per key) <sub>1.2</sub> |
| `toPatch(skip?)` | materialize the drafts as `[{ key, from, to }, ...]` (cold convenience over `forEachPatch`) <sub>1.2</sub> |
| `reconcileAll(policy?)` | drop overlays the policy confirms against the current source |
| `prune()` | release slots for keys that are neither overlaid nor observed; returns how many were freed <sub>1.1</sub> |
| `dispose()` | recycle every projection-owned node back to the pool |

### `keyedStore(initial?) -> { get, set, has, keys }`

A minimal built-in keyed reactive source: one lazily-created signal per key. Handy when you do not need a full lite-store.

### Reconciliation helpers

- `confirmOnEcho(authoritative, overlay)` — default policy: confirmed once `Object.is(authoritative, overlay)` (the source echoed the optimistic value back).
- `makeReconciler(view, policy?)` — returns a per-key handler `(key, authoritativeValue) => void` for a source that emits incoming-update events. When an update arrives for an overlaid key and the policy confirms it, the overlay is dropped.

### Source adapters

- `fromAccessors(get, set)` — shape a plain accessor pair into a source.
- `fromProxy(obj)` — shape a property-style reactive store (a Proxy, a lite-store proxy) into a source; `obj[key]` must be a tracked read.

## Library adapters

### `projectStore(store)` — drafts over [lite-store](https://www.npmjs.com/package/@zakkster/lite-store)

```js
import { projectStore } from "@zakkster/lite-project";
import { store } from "@zakkster/lite-store";

const s = store({ name: "alice", age: 30 });
const draft = projectStore(s);

draft.set("name", "bob");   // draft only; s.name is still "alice"
draft.commit();             // s.name === "bob"
```

lite-store gives per-key signals, so the projection stays granular: overlaying or committing one key only re-runs that key's consumers. Projects the **top-level** keys of the given proxy — pass a nested proxy (`projectStore(s.user)`) to project deeper.

### `projectRoom(room, { policy })` — optimistic drafts over [lite-room](https://www.npmjs.com/package/@zakkster/lite-room)

```js
import { projectRoom } from "@zakkster/lite-project";

const draft = projectRoom(room);   // over room.storage (LWW-Map)

draft.set("cell:A1", "=SUM(B:B)"); // local optimistic edit, NOT synced
draft.commit();                    // promotes via room.storage.set (writes + syncs to peers)
```

Room storage is authoritative and CRDT-merged, so the projection is **presentation-only**: it never joins the merge. `set` stages a local draft, `commit()` promotes it through `room.storage.set`, and an auto-reconcile drops drafts once the authoritative value catches up (echo) while leaving a conflicting authoritative value **masked** (no flicker). Because `room.storage` is coarse (a single `entries` signal, a plain non-reactive `get`), the adapter subscribes through `entries()` and the projection inherits that coarse granularity. Call `dispose()` to stop the reconcile effect. Only `room.storage` is projectable this way; sets / lists / texts have non-keyed shapes.

### `projectQuery(qc, key, { data, policy, merge })` — optimistic field drafts over [lite-query](https://www.npmjs.com/package/@zakkster/lite-query)

```js
import { projectQuery } from "@zakkster/lite-project";

const query = qc.createQuery(["user", id], fetchUser);
const draft = projectQuery(qc, ["user", id], { data: query.data });

draft.set("name", "Ada");          // optimistic field edit, cache untouched
draft.set("email", "ada@x.dev");
draft.commit();                    // ONE setQueryData merging both fields back in
```

Projects a single query entry's data **object**, exposing its **fields** as the projected keys. `commit()` folds every staged field into the cached record in a **single** `setQueryData(key, prev => merge(prev, overlays))` write (one cache mutation, one broadcast), rather than one write per field; `commit(field)` writes just one. Pass the query's reactive `data` accessor so reads track the cache and an auto-reconcile drops drafts a refetch confirms (echo) while masking conflicts — omit it to degrade to a non-reactive `getQueryData` snapshot with no auto-reconcile. `merge` defaults to a shallow spread (a nullish `prev` seeds a fresh record); `policy` defaults to `confirmOnEcho`. The client is consumed structurally (`getQueryData` / `setQueryData`), so there's no hard dependency on lite-query. `dispose()` stops the reconcile effect.

The default merge copies **own enumerable** properties, symbols included, and defines them rather than assigning them. That matters for three field names you would otherwise lose silently: a field literally called `__proto__` lands as a real own key (assignment would retarget the prototype and drop it), inherited properties on `prev` are not absorbed into the record, and a symbol-keyed draft survives the commit instead of evaporating while `dirtyCount()` reports it saved. A custom `merge` is on its own for all three.

### `projectCRDT(map, { policy, transact })` -- fine-grained drafts over [lite-crdt](https://www.npmjs.com/package/@zakkster/lite-crdt) <sub>1.4</sub>

```js
import { projectCRDT } from "@zakkster/lite-project";

const doc = createCRDTDoc({ replicaId });
const map = doc.map("profile");                       // a lite-crdt LWW-Map
const draft = projectCRDT(map, { transact: doc.transact });

draft.set("name", "Ada");          // optimistic edit, the CRDT is untouched
draft.set("city", "London");
draft.commit();                    // both cells promoted in ONE ops frame (transact)
```

Where `projectRoom` wraps lite-room's **coarse** storage (a single `entries` signal -- any change re-evaluates every projected key), a lite-crdt LWW-Map exposes a **fine-grained** reactive `get(key)`, so `projectCRDT` is truly granular: overlaying or committing one cell never re-runs a consumer of another. `set(key, value)` stages a local draft (no op emitted); `commit(key?)` promotes drafts through `map.set` -- one op per committed key (LWW ops are commutative and idempotent, so N frames are semantically one). Pass `transact` (e.g. `doc.transact`) to coalesce a burst into a single ops frame; it wraps both `commit` and `commitWhere`. An auto-reconcile drops a draft the authoritative cell catches up to (a local echo or a remote `applyOp`) while leaving **conflicts** -- and a concurrent authoritative **delete**, which reads as `undefined` -- masked. The map is consumed structurally (any `{ get, set }` whose `get` is fine-grained reactive), so there is no hard dependency on lite-crdt, and the projection never touches the doc or `map.store`. `dispose()` stops the reconcile effect.

Two hazards are recorded contracts, not bugs:

- **Read-only object wrapper.** lite-crdt's `get(key)` returns a deep **read-only wrapper** for object/array values (a different reference than the one you passed to `set`). So `confirmOnEcho` (`Object.is`) can never auto-confirm an **object-valued** draft, even on a genuine local echo -- the wrapper breaks reference equality. Use a `{ ttl }` draft (the shipped self-heal) or a caller-supplied **structural** policy, whose reads pass through the wrapper transparently; never mutate the authoritative value a policy is handed (it is read-only and lite-crdt throws). Scalars confirm normally.
- **String-coercion key aliasing.** lite-crdt coerces every map key to a string. Drafts on `5` and `"5"` are two projection slots that commit into one cell (last write wins), and `dirtyCount()` never reveals the collision -- stage under one key type. A `"__proto__"` map key throws `CRDTError` on commit (fail closed: the draft stays staged). And because `doc.dispose()` makes writes silent no-ops, a commit **after** the doc is disposed writes nothing yet still clears the drafts -- dispose the projection before the doc.

## Patch emission <sub>1.2</sub>

The overlay bag already knows every staged draft's `to`; `forEachPatch` adds the source's `from` so a draft can cross the wire without re-walking the view.

```js
const draft = project(source);
draft.set("name", "Ada");
draft.set("email", "ada@x.dev");

// Zero-alloc callback: hand each draft to a serializer / transport.
draft.forEachPatch((key, from, to) => {
  wire.send({ op: "set", key, prev: from, next: to });
});

// Cold convenience: materialize the same deltas as an array.
const patch = draft.toPatch();   // [{ key: "name", from: undefined, to: "Ada" }, ...]
```

`from` is the **untracked** current source value, `to` the staged overlay. Both methods are read-only and untracked -- calling them inside an effect subscribes it to nothing -- and visit exactly the overlaid keys, in `forEachOverlay` order. `forEachPatch` allocates nothing per key; `toPatch` is the cold convenience whose per-key record is its documented allocation.

An overlaid key is emitted whether or not `Object.is(from, to)`: the visit set stays equal to `dirtyCount()` and `commit()`'s write set, so a patch consumer (an LWW-Map op, a CRDT bump, an HTTP PATCH field) is never silently dropped. To suppress unchanged drafts, pass the same predicate shape reconcile uses -> `draft.forEachPatch(fn, confirmOnEcho)`. A throwing `source.get` propagates on the offending key with the overlay bag intact; callers needing atomicity use `toPatch()` (a partial array never escapes). The patch and `commit()` are two views of one delta: applying `toPatch()` to a copy of the source yields the same state `commit()` would write.

Present on the `projectStore` / `projectRoom` / `projectQuery` handles too (for `projectQuery`, `from` is the cached record's field value).

## Overlay TTL + partial commit <sub>1.3</sub>

A pending overlay that never gets its ack has no way back. `set(key, value, { ttl })` gives it one: the overlay auto-**reverts** at `now() + ttl` (a finite number > 0), dropping the draft while the source stays untouched -- "the optimistic edit expired; fall back to authoritative".

```js
const draft = project(source);

draft.set("status", "saving", { ttl: 5000 });   // reverts in 5s unless the ack clears it first
// ... the server confirms -> draft.clear("status") (or reconcile) cancels the expiry
```

One re-armed timer runs per projection (each key stores its own deadline; arm and fire do an `O(slots)` cold scan, so the warm `set` path allocates nothing). A bad `ttl` throws **before** staging. A re-set **with** `ttl` re-arms; a re-set **without** `ttl` cancels the pending expiry -- each `set` fully specifies its overlay's lifetime. Every transition to un-overlaid (`clear`, `commit`, `revert`, a reconcile drop, `commitWhere` / `clearWhere`, and the fire itself) cancels that key's expiry, and `dispose()` cancels any pending handle.

For a **deterministic** TTL (tests, an animation clock, a server tick) pass an injectable clock -- all-or-none, or a mixed clock is a `TypeError`:

```js
let t = 0;
const clock = { now: () => t, setTimer: (fn, ms) => schedule(fn, t + ms), clearTimer: cancel };
const draft = project(source, clock);            // forwarded by projectStore/projectRoom/projectQuery too
```

`commitWhere(pred)` and `clearWhere(pred)` are predicate-scoped partial saves: `pred(key, stagedValue)` (the `forEachOverlay` callback order) selects which overlays to act on, in one reactive propagation. `commitWhere` writes and clears only the matches; `clearWhere` discards them with zero source writes. A throwing `pred` is non-atomic on the core handle -- already-committed keys stay committed and `dirtyCount() === overlaidCount()`. On `projectQuery`, `commitWhere` is still a **single** `setQueryData` write for the matching fields, and the non-matching drafts survive.

```js
draft.set("name", "Ada");
draft.set("email", "ada@x.dev");
draft.commitWhere((key) => key !== "email");     // save name, keep email staged
```

**F-03.** `confirmOnEcho` is reference-equality (`Object.is`), so an object-valued draft can never echo-confirm against a structurally-equal source value of a different reference. The fix is a **caller-supplied** structural policy -- `reconcileAll(policy)` and the `forEachPatch` skip param both accept one; this library ships **no** deep-equal helper (a naive structural equal is a fail-open trap). The TTL is the shipped safety net: a stuck object draft self-heals on its deadline.

## Conventions

ESM only. ASCII source. `node:test`. MIT.

## License

MIT (c) 2026 Zahary Shinikchiev
