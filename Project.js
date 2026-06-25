/**
 * @zakkster/lite-project v1.0.0 -- zero-GC projections for @zakkster/lite-signal.
 * -----------------------------------------------------------------------------
 * A projection is a granular, derived, NON-MUTATING reactive view over a keyed
 * source: a lens that can carry ephemeral overlays (optimistic edits, merges,
 * "pending" state) without touching the underlying data, then commit() those
 * overlays into the source or revert() them. It is the "Beyond Signals"
 * projection primitive, built on lite-signal's pool so the steady state allocates
 * nothing the engine can avoid.
 *
 * -- THE THREE PROPERTIES --
 *   granular     reading key K subscribes only to K's effective value; overlaying
 *                key A never re-runs a consumer of key B (each projected key is its
 *                own computed).
 *   derived      get(key) is reactive: it tracks BOTH the overlay and the source
 *                cell, so a revert (or a source change after a revert) flows through.
 *   non-mutating set(key, v) writes an overlay ONLY; the source is untouched until
 *                commit(). revert() drops the overlay layer entirely. While a key is
 *                overlaid, a source change to that key is masked (the projected value
 *                stays the overlay) and -- thanks to the engine's Object.is short-
 *                circuit -- does NOT churn downstream consumers. The optimistic value
 *                is stable under source noise.
 *
 * -- OWNERSHIP (why createRoot) --
 * Per-key nodes are created LAZILY, on the first get/set of a key -- which happens
 * inside whatever consumer effect first reads that key. Without detachment the
 * projected computed would be ADOPTED by that consumer and cascade-disposed on its
 * next re-run, silently breaking the projection. createRoot() detaches owner +
 * observer for the creation, so the nodes are unowned and survive; the projection
 * disposes them itself (dispose()). The overlay signal is safe regardless (plain
 * signals are never adopted), but the computed needs the detached scope.
 *
 * -- ZERO-GC, AND THE HONEST NON-CLAIM --
 * PASS: get / set / clear on an ALREADY-TOUCHED key allocate nothing -- a computed
 *       read, or a Map.get + a signal write. Overlay churn over a bounded key set
 *       (toggle pending on/off, the realistic optimistic-UI shape) pulls no node from
 *       the pool and never grows it.
 * NOT claimed: the FIRST touch of a brand-new key. It allocates a slot record + a Map
 *       entry (JS handles) and two pooled nodes (overlay signal + projected computed).
 *       The nodes come from the pool (poolGrowth 0 after warm-up); the slot/Map entry
 *       are the public-handle cost, the same split @zakkster/lite-signal itself draws
 *       between pooled internals and escaping handles. Warm the keys you will churn.
 *
 * Registry-parametric: createProjector(reg) binds to any registry (the default one,
 * or a createRegistry({...}) for isolated tests). Default-bound `project` /
 * `keyedStore` are exported for the common case.
 *
 * MIT (c) Zahary Shinikchiev
 */

import {
    signal as _signal,
    computed as _computed,
    createRoot as _createRoot,
    dispose as _dispose,
    untrack as _untrack,
    effect as _effect,
    batch as _batch,
} from "@zakkster/lite-signal";

// Module-level sentinel for "this key has no overlay". A unique symbol, never a
// per-operation allocation. Stored directly in the overlay signal's value slot, so
// "absent" and "present with value V" share one node and one field -- no boxing.
const ABSENT = Symbol("projection.absent");

/**
 * Bind the projection primitives to a registry. Pass the default-registry
 * namespace for normal use, or a `createRegistry({...})` result for an isolated
 * graph (tests, the zero-GC gate).
 *
 * @param {{signal:Function, computed:Function, createRoot:Function, dispose:Function}} reg
 * @returns {{project:Function, keyedStore:Function}}
 */
export function createProjector(reg) {
    const signal = reg.signal;
    const computed = reg.computed;
    const createRoot = reg.createRoot;
    const dispose = reg.dispose;
    const untrack = reg.untrack;
    // commit / revert / reconcileAll write many signals in a loop; batch coalesces
    // them (and the dirty-counter write) into ONE propagation so a multi-key
    // consumer never observes a torn, partially-applied snapshot. Fallback keeps a
    // minimal custom registry working (unbatched == synchronous, as before).
    const batch = reg.batch || ((fn) => { fn(); });

    /**
     * Minimal keyed reactive source: one lazily-created signal per key. Provided so
     * a projection has something to wrap out of the box; any object with reactive
     * `get(key)` and `set(key, value)` works equally (e.g. lite-store).
     *
     * @param {Record<PropertyKey, unknown>} [initial] Optional seed entries.
     * @returns {{get:(key:PropertyKey)=>unknown, set:(key:PropertyKey, v:unknown)=>void,
     *           has:(key:PropertyKey)=>boolean, keys:()=>IterableIterator<PropertyKey>}}
     */
    function keyedStore(initial) {
        const cells = new Map();
        const cell = (key) => {
            let c = cells.get(key);
            if (c === undefined) { c = signal(undefined); cells.set(key, c); }
            return c;
        };
        if (initial !== undefined) for (const k in initial) cell(k).set(initial[k]);
        return {
            get: (key) => cell(key)(),
            set: (key, v) => cell(key).set(v),
            has: (key) => cells.has(key),
            keys: () => cells.keys(),
        };
    }

    /**
     * Project a keyed source. The returned handle reads through an ephemeral overlay
     * and can commit / revert it.
     *
     * @param {{get:(key:PropertyKey)=>unknown, set:(key:PropertyKey, v:unknown)=>void}} source
     * @returns {{
     *   get:(key:PropertyKey)=>unknown,         // reactive: overlay value if set, else source
     *   set:(key:PropertyKey, v:unknown)=>void,  // stage an EPHEMERAL overlay (source untouched)
     *   clear:(key:PropertyKey)=>void,           // drop one key's overlay (revert that key)
     *   isOverlaid:(key:PropertyKey)=>boolean,   // untracked diagnostic
     *   overlaidCount:()=>number,                // untracked diagnostic
     *   dirtyCount:()=>number,                   // TRACKED: count of staged overlays (reactive)
     *   isDirty:()=>boolean,                     // TRACKED: any staged overlays? (reactive)
     *   peek:(key:PropertyKey)=>unknown,         // untracked effective read (no subscribe)
     *   forEachOverlay:(fn:(key:PropertyKey, value:unknown)=>void)=>void, // iterate overlaid keys (untracked)
     *   reconcileAll:(policy?:(authoritative:unknown, overlayValue:unknown, key:PropertyKey)=>boolean)=>void, // drop confirmed overlays
     *   commit:(key?:PropertyKey)=>void,         // write one key's overlay, or all, into the source then clear
     *   revert:()=>void,                         // drop all overlays
     *   dispose:()=>void,                        // recycle every projection-owned node to the pool
     * }}
     */
    function project(source) {
        // key -> { ov: overlay signal (ABSENT | value), read: projected computed }.
        // Lazily populated. One entry per touched key, retained until dispose().
        const slots = new Map();

        const slotFor = (key) => {
            let s = slots.get(key);
            if (s === undefined) {
                // Detach owner+observer for creation: these nodes outlive the consumer
                // that first reads `key`, and the projection -- not that consumer --
                // owns their disposal. (See header: OWNERSHIP.)
                s = createRoot(() => {
                    const ov = signal(ABSENT);
                    const read = computed(() => {
                        const o = ov();              // track the overlay
                        const base = source.get(key); // track the source cell too
                        return o === ABSENT ? base : o;
                    });
                    return { ov, read };
                });
                slots.set(key, s);
            }
            return s;
        };

        // Reactive dirty state. ONE fixed signal per projection (created detached so
        // dispose() owns its teardown, like the per-key nodes). `dirty` is the
        // source-of-truth count of staged overlays, mirrored into the signal on every
        // presence transition (absent<->value). Bumping it allocates nothing -- a
        // number set, marking subscribers without allocation -- so the zero-GC churn
        // property holds even with a Save button subscribed to isDirty().
        const dirtySig = createRoot(() => signal(0));
        let dirty = 0;

        return {
            get: (key) => slotFor(key).read(),
            set: (key, v) => {
                const s = slotFor(key);
                const wasAbsent = s.ov.peek() === ABSENT;
                s.ov.set(v);
                if (wasAbsent) { dirty++; dirtySig.set(dirty); }
            },
            clear: (key) => {
                const s = slots.get(key);
                if (s !== undefined && s.ov.peek() !== ABSENT) {
                    s.ov.set(ABSENT);
                    dirty--; dirtySig.set(dirty);
                }
            },
            isOverlaid: (key) => {
                const s = slots.get(key);
                return s !== undefined && s.ov.peek() !== ABSENT;
            },
            // Reactive dirty state (tracked) -- for "unsaved changes" badges and
            // enabling/disabling Save without polling. isOverlaid / overlaidCount above
            // stay UNTRACKED for diagnostic reads that must not subscribe.
            dirtyCount: () => dirtySig(),
            isDirty: () => dirtySig() > 0,
            // Untracked effective read (overlay if set, else source) -- for
            // reconciliation policies and imperative inspection, without subscribing.
            peek: (key) => {
                const s = slots.get(key);
                if (s === undefined) return untrack(() => source.get(key));
                const o = s.ov.peek();
                return o === ABSENT ? untrack(() => source.get(key)) : o;
            },
            // Iterate currently-overlaid keys (untracked). Cold path.
            forEachOverlay: (fn) => {
                for (const [key, s] of slots) {
                    const o = s.ov.peek();
                    if (o !== ABSENT) fn(key, o);
                }
            },
            // Full-snapshot reconciliation: drop every overlay the policy considers
            // confirmed against the CURRENT (untracked) source value. For sources that
            // sync wholesale rather than per-key. Presentation-only -- the source owns
            // the real write; this only decides what the local view stops overriding.
            reconcileAll: (policy) => {
                const pol = policy || confirmOnEcho;
                batch(() => {
                    let dropped = 0;
                    for (const [key, s] of slots) {
                        const o = s.ov.peek();
                        if (o !== ABSENT) {
                            const authoritative = untrack(() => source.get(key));
                            if (pol(authoritative, o, key)) { s.ov.set(ABSENT); dropped++; }
                        }
                    }
                    if (dropped) { dirty -= dropped; dirtySig.set(dirty); }
                });
            },
            overlaidCount: () => {
                let n = 0;
                for (const s of slots.values()) if (s.ov.peek() !== ABSENT) n++;
                return n;
            },
            commit: (key) => {
                // Cold path (a user "save"): may iterate + write the source freely.
                // commit(key) writes one overlay; commit() writes all. (Keys are
                // PropertyKey, never undefined, so `key === undefined` means "all".)
                batch(() => {
                    if (key !== undefined) {
                        const s = slots.get(key);
                        if (s !== undefined) {
                            const o = s.ov.peek();
                            if (o !== ABSENT) {
                                source.set(key, o); s.ov.set(ABSENT);
                                dirty--; dirtySig.set(dirty);
                            }
                        }
                        return;
                    }
                    let changed = false;
                    for (const [k, s] of slots) {
                        const o = s.ov.peek();
                        if (o !== ABSENT) { source.set(k, o); s.ov.set(ABSENT); changed = true; }
                    }
                    if (changed) { dirty = 0; dirtySig.set(0); }
                });
            },
            revert: () => {
                batch(() => {
                    let changed = false;
                    for (const s of slots.values()) {
                        if (s.ov.peek() !== ABSENT) { s.ov.set(ABSENT); changed = true; }
                    }
                    if (changed) { dirty = 0; dirtySig.set(0); }
                });
            },
            dispose: () => {
                // createRoot left these unowned, so nothing auto-disposes them.
                // Dispose the computed before its overlay so the read never re-evaluates
                // against a recycled signal.
                for (const s of slots.values()) { dispose(s.read); dispose(s.ov); }
                dispose(dirtySig);
                slots.clear();
                dirty = 0;
            },
        };
    }

    return { project, keyedStore };
}

// Default-registry convenience: project / keyedStore bound to the default registry,
// for the common single-registry case.
const _default = createProjector({
    signal: _signal,
    computed: _computed,
    createRoot: _createRoot,
    dispose: _dispose,
    untrack: _untrack,
    batch: _batch,
});

export const project = _default.project;
export const keyedStore = _default.keyedStore;

// ---- integration helpers (registry-independent) ------------------------------

/**
 * Default reconciliation policy: an overlay is confirmed once the authoritative
 * value equals the optimistic one (the source echoed it back). Object.is.
 *
 * @param {unknown} authoritative The value the source now holds.
 * @param {unknown} overlayValue  The optimistic value staged in the projection.
 * @returns {boolean}             true => drop the overlay.
 */
export function confirmOnEcho(authoritative, overlayValue) {
    return Object.is(authoritative, overlayValue);
}

/**
 * Shape a plain accessor pair into a projection source.
 * @param {(key:PropertyKey)=>unknown} get  Reactive read.
 * @param {(key:PropertyKey, v:unknown)=>void} set Write.
 */
export function fromAccessors(get, set) { return { get, set }; }

/**
 * Shape a property-style reactive store (e.g. a proxy, or lite-store's proxy
 * surface) into a projection source. `obj[key]` must be a TRACKED read and
 * `obj[key] = v` a write.
 * @param {object} obj
 */
export function fromProxy(obj) {
    return { get: (k) => obj[k], set: (k, v) => { obj[k] = v; } };
}

/**
 * Per-key reconciler for an authoritative source that emits incoming-update
 * events (a CRDT room, a socket). Wire the returned handler to that event: when
 * an update arrives for an overlaid key and `policy` considers it confirmed, the
 * optimistic overlay is dropped. Presentation-only -- the source / CRDT owns the
 * real write and the merge; this only decides when the local view stops overriding.
 *
 * @example
 *   const onUpdate = makeReconciler(view);          // echo policy
 *   room.onUpdate(onUpdate);                          // room fires (key, authoritativeValue)
 *
 * @param {{isOverlaid:Function, peek:Function, clear:Function}} view A project() handle.
 * @param {(authoritative:unknown, overlayValue:unknown, key:PropertyKey)=>boolean} [policy]
 * @returns {(key:PropertyKey, authoritativeValue:unknown)=>void}
 */
export function makeReconciler(view, policy) {
    const pol = policy || confirmOnEcho;
    return (key, authoritativeValue) => {
        if (view.isOverlaid(key) && pol(authoritativeValue, view.peek(key), key)) view.clear(key);
    };
}

// ---- library adapters (default registry) -------------------------------------
// lite-store and lite-room both bind the default lite-signal registry, so these
// adapters use the default-bound `project` and `_effect`. They are written
// against the published surfaces of @zakkster/lite-store v1.0.0 and
// @zakkster/lite-room.

/**
 * Project a @zakkster/lite-store proxy as a DRAFT overlay. lite-store gives
 * per-key signals (a property becomes reactive the first time it is read in a
 * reactive scope), so the projection inherits that granularity: overlaying or
 * committing one key only re-runs consumers of that key.
 *
 *   - set(key, value)  stage a draft (the store is NOT mutated)
 *   - commit()         write drafts through (`store[key] = draft`), firing the
 *                      store's per-key signals
 *   - revert()         discard all drafts
 *   - clear(key)       discard one draft
 *
 * Projects the TOP-LEVEL keys of the given proxy. To project a nested object,
 * pass the nested proxy: `projectStore(s.user)` (lite-store hands out a child
 * proxy on property access, and that child has its own per-key signals).
 *
 * @param {object} store A lite-store proxy from `store(...)`.
 * @returns {object} A projection handle (get/set/clear/commit/revert/isOverlaid/peek/...).
 */
export function projectStore(store) {
    return project(fromProxy(store));
}

/**
 * Project a @zakkster/lite-room's LWW-Map (`room.storage`) as a DRAFT layer for
 * optimistic / tentative UI. Room storage is authoritative and CRDT-merged, so
 * the projection never participates in the merge -- it only decides what the
 * local view tentatively overrides:
 *
 *   - set(key, value)  stage a draft -- local only, NOT synced, CRDT untouched
 *   - commit()         promote drafts via `room.storage.set` (writes + syncs)
 *   - revert()         discard drafts
 *   - auto-reconcile   whenever authoritative storage changes, drafts the policy
 *                      considers confirmed are dropped; a CONFLICTING
 *                      authoritative value leaves the draft masked (the engine's
 *                      Object.is short-circuit suppresses the flicker)
 *
 * room.storage is COARSE -- a single `entries` signal fires on any change and
 * `get(key)` is a plain (non-reactive) Map read -- so the source adapter
 * subscribes through `entries()` before reading, and the projection inherits
 * that coarse granularity (any storage change re-evaluates every projected key).
 * Per-key room signals would refine both layers at once. Only `room.storage` is
 * projectable this way; sets / lists / texts have non-keyed shapes.
 *
 * @param {object} room A room handle from `createRoom(...)`.
 * @param {{policy?: (authoritative:unknown, draft:unknown, key:PropertyKey)=>boolean}} [opts]
 *        Reconciliation policy; defaults to confirmOnEcho (drop when authoritative === draft).
 * @returns {object} A projection handle whose dispose() also stops the reconcile effect.
 */
export function projectRoom(room, opts) {
    const policy = (opts && opts.policy) || confirmOnEcho;
    const source = {
        // Subscribe to the coarse `entries` signal so the projected read reacts
        // to any authoritative change, then return the current value for `key`.
        get: (key) => { room.storage.entries(); return room.storage.get(key); },
        set: (key, value) => room.storage.set(key, value),
    };
    const view = project(source);
    // Drop confirmed drafts whenever authoritative state changes. The effect
    // tracks `entries` (not overlays/projected computeds), so view.clear() inside
    // reconcileAll never re-triggers it -> no loop. reconcileAll reads the source
    // untracked, so it adds no dependency.
    const stopReconcile = _effect(() => {
        room.storage.entries();
        view.reconcileAll(policy);
    });
    return {
        ...view,
        dispose: () => { stopReconcile(); view.dispose(); },
    };
}
