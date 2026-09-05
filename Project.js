/**
 * @zakkster/lite-project v1.4.1 -- zero-GC projections for @zakkster/lite-signal.
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
 * Patch emission (forEachPatch / toPatch) exposes the staged drafts as a
 * (key, from, to) stream for a save/sync trigger. It is READ-ONLY and UNTRACKED:
 * it never touches the source or the overlays and subscribes the caller to nothing.
 *
 * -- OVERLAY TTL + PARTIAL COMMIT (1.3) --
 * set(key, v, {ttl}) stages an overlay that auto-REVERTS at now()+ttl (drop the
 * overlay, source untouched -- "the optimistic edit expired, fall back to
 * authoritative"). ONE re-armed platform timer per projection; each slot stores its
 * own deadline; every transition to ABSENT cancels that key's expiry. The clock is
 * injectable and all-or-none via project(source, {now, setTimer, clearTimer}) --
 * a mixed clock is a TypeError. commitWhere(pred) / clearWhere(pred) apply a
 * predicate-scoped partial save / discard: pred(key, stagedValue), the
 * forEachOverlay callback order.
 *
 * -- F-03 (recorded) -- confirmOnEcho is reference-equality (Object.is): an
 * object-valued draft can never echo-confirm against a structurally-equal source
 * value of a different reference. The fix is a CALLER-supplied structural policy
 * (reconcileAll(policy) / the forEachPatch skip param accept one); this library
 * ships NO deep-equal helper (a naive structural equal is a fail-open trap). The
 * TTL is the shipped safety net: a stuck object draft self-heals on its deadline.
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
 * -- ADAPTERS -- projectStore / projectRoom / projectQuery / projectCRDT [1.4].
 * projectCRDT wraps a @zakkster/lite-crdt LWW-Map's FINE-GRAINED reactive get(key)
 * for true per-key drafts. TWO recorded hazards: (1) get(key) returns a deep
 * READ-ONLY WRAPPER for object values, so confirmOnEcho (Object.is) can never
 * auto-confirm an object draft (use {ttl} or a structural policy; never mutate the
 * authoritative wrapper); (2) lite-crdt STRING-COERCES keys, so drafts on `5` and
 * `"5"` are two slots that commit into one cell (last write wins) -- stage under
 * one key type. See the projectCRDT JSDoc for the full contract.
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
    hasObservers as _hasObservers,
} from "@zakkster/lite-signal";

export const VERSION = "1.4.1";

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
    // Optional: only prune() needs it. A custom registry that does not provide it
    // simply gets a prune() that reclaims nothing rather than a crash.
    const hasObservers = reg.hasObservers;
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
     * @param {{now?:Function, setTimer?:Function, clearTimer?:Function}} [opts] Optional
     *        injectable clock for overlay TTL (all-or-none: if any is supplied, all three
     *        must be functions). Defaults wrap performance.now / setTimeout / clearTimeout.
     * @returns {{
     *   get:(key:PropertyKey)=>unknown,         // reactive: overlay value if set, else source
     *   set:(key:PropertyKey, v:unknown, opts?:{ttl?:number})=>void, // stage an EPHEMERAL overlay; {ttl} auto-reverts it (source untouched)
     *   clear:(key:PropertyKey)=>void,           // drop one key's overlay (revert that key)
     *   isOverlaid:(key:PropertyKey)=>boolean,   // untracked diagnostic
     *   overlaidCount:()=>number,                // untracked diagnostic
     *   dirtyCount:()=>number,                   // TRACKED: count of staged overlays (reactive)
     *   isDirty:()=>boolean,                     // TRACKED: any staged overlays? (reactive)
     *   peek:(key:PropertyKey)=>unknown,         // untracked effective read (no subscribe)
     *   forEachOverlay:(fn:(key:PropertyKey, value:unknown)=>void)=>void, // iterate overlaid keys (untracked)
     *   forEachPatch:(fn:(key:PropertyKey, from:unknown, to:unknown)=>void, skip?:Function)=>void, // patch stream (untracked, read-only)
     *   toPatch:(skip?:Function)=>Array<{key:PropertyKey, from:unknown, to:unknown}>, // materialized patch (cold convenience)
     *   reconcileAll:(policy?:(authoritative:unknown, overlayValue:unknown, key:PropertyKey)=>boolean)=>void, // drop confirmed overlays
     *   commit:(key?:PropertyKey)=>void,         // write one key's overlay, or all, into the source then clear
     *   commitWhere:(pred:(key:PropertyKey, value:unknown)=>boolean)=>void, // write + clear only the matching overlays
     *   clearWhere:(pred:(key:PropertyKey, value:unknown)=>boolean)=>void,  // drop only the matching overlays (source untouched)
     *   revert:()=>void,                         // drop all overlays
     *   dispose:()=>void,                        // recycle every projection-owned node to the pool
     * }}
     */
    function project(source, opts) {
        // Injectable, all-or-none clock (S1). now/setTimer/clearTimer let the TTL
        // run on a deterministic timeline in tests. A MIXED clock computes
        // deadlines on one timeline and arms on another -> fail closed. Defaults
        // wrap the platform globals in arrows: bare `setTimeout` refs throw
        // "Illegal invocation" in browsers, and performance.now is monotonic so an
        // NTP step cannot make a deadline unreachable (setTimer takes a delta).
        if (opts != null && typeof opts !== "object") {
            throw new TypeError("project: opts must be an object");
        }
        let _now, _setTimer, _clearTimer;
        if (opts != null && (opts.now !== undefined || opts.setTimer !== undefined || opts.clearTimer !== undefined)) {
            if (typeof opts.now !== "function" || typeof opts.setTimer !== "function" || typeof opts.clearTimer !== "function") {
                throw new TypeError("project: now/setTimer/clearTimer must all be functions (all-or-none clock)");
            }
            _now = opts.now; _setTimer = opts.setTimer; _clearTimer = opts.clearTimer;
        } else {
            _now = () => performance.now();
            _setTimer = (fn, ms) => setTimeout(fn, ms);
            _clearTimer = (h) => clearTimeout(h);
        }

        // key -> { ov: overlay signal (ABSENT | value), read: projected computed,
        // exp: deadline (0 == no expiry) }. Lazily populated. One entry per touched
        // key, retained until dispose(). `exp` is a THIRD field at birth so the
        // hidden class is stable; a ttl set is one field write, never a side Map.
        // Invariant: exp !== 0 implies overlaid, so prune() never orphans a deadline.
        const slots = new Map();

        // Slot creation lives in its OWN function, never inline in slotFor: the
        // creation closure captures `key`, and a capture inside slotFor's scope
        // would make V8 allocate a context object on EVERY slotFor call -- hit or
        // miss -- taxing get/peek/set ~40 B/op. Here the context is allocated only
        // on the cold miss. (Bytes in a hot body: a closure in a cold branch still
        // costs the hot branch its context.)
        const _createSlot = (key) => {
            // Detach owner+observer for creation: these nodes outlive the consumer
            // that first reads `key`, and the projection -- not that consumer --
            // owns their disposal. (See header: OWNERSHIP.)
            return createRoot(() => {
                const ov = signal(ABSENT);
                const read = computed(() => {
                    const o = ov();              // track the overlay
                    const base = source.get(key); // track the source cell too
                    return o === ABSENT ? base : o;
                });
                return { ov, read, exp: 0 };
            });
        };
        const slotFor = (key) => {
            let s = slots.get(key);
            if (s === undefined) { s = _createSlot(key); slots.set(key, s); }
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

        // -- Overlay TTL (per-projection). ONE platform timer, re-armed; each slot
        // stores its own deadline in `exp`, and arm/fire do an O(slots) cold scan.
        // A min-heap would allocate per push -- rejected. `armedAt` is the deadline
        // the live handle is set for; clear-before-set in _armAt bounds outstanding
        // handles to exactly 1 (T7). ttlCount is the count of slots with exp !== 0.
        let timerHandle = null; let armedAt = 0; let ttlCount = 0;
        const _cancelTimer = () => {
            if (timerHandle !== null) { _clearTimer(timerHandle); timerHandle = null; armedAt = 0; }
        };
        const _armAt = (d) => {
            if (timerHandle !== null) _clearTimer(timerHandle);   // clear-before-set: <= 1 handle
            armedAt = d;
            const ms = d - _now();
            timerHandle = _setTimer(_fire, ms > 0 ? ms : 0);      // clamp delta >= 0
        };
        // THE single cancellation helper: every transition to ABSENT calls it, so a
        // stale deadline can never outlive its overlay. A hoisted function
        // declaration (not an arrow) so it is defined before the closures above
        // that reference it.
        function _dropExp(s) {
            if (s.exp !== 0) { s.exp = 0; if (--ttlCount === 0) _cancelTimer(); }
        }
        // The existing plain-set body, hoisted: stage `v` as an overlay and keep the
        // dirty bookkeeping. Returns the slot so callers can set/clear its expiry.
        const _stage = (key, v) => {
            const s = slotFor(key);
            const wasAbsent = s.ov.peek() === ABSENT;
            s.ov.set(v);
            if (wasAbsent) { dirty++; dirtySig.set(dirty); }
            return s;
        };
        // The fire handler: ONE hoisted per-projection closure (the _readSrc
        // precedent). Reverts exactly the keys due (exp <= now), in one batch, with
        // per-drop dirty bookkeeping (clear()'s fail-closed pattern: a throwing
        // _now/registry leaves dirty == overlaid count). The source is NEVER touched.
        // _rearm runs AFTER the batch, so a subscriber's set(k,v,{ttl}) during the
        // flush is honoured; _armAt clears first, so still <= 1 handle (T1).
        const _fire = () => {
            timerHandle = null; armedAt = 0;
            if (ttlCount === 0) return;               // spurious after a full cancel / post-dispose
            const t = _now();
            batch(() => {
                for (const s of slots.values()) {
                    const e = s.exp;
                    if (e === 0 || e > t) continue;   // not due -> untouched
                    _dropExp(s);
                    if (s.ov.peek() !== ABSENT) { s.ov.set(ABSENT); dirty--; dirtySig.set(dirty); }
                }
            });
            _rearm();
        };
        const _rearm = () => {
            if (ttlCount === 0) { _cancelTimer(); return; }
            let min = Infinity;
            for (const s of slots.values()) { const e = s.exp; if (e !== 0 && e < min) min = e; }
            if (min === Infinity) { ttlCount = 0; _cancelTimer(); return; }   // defensive, fail closed
            _armAt(min);
        };
        // Cold ttl branch of set(). A {}/{policy} bag (ttl === undefined) behaves as
        // plain set AND still cancels a prior expiry. A bad ttl throws BEFORE staging,
        // so the bag and source stay untouched. A re-set with an EARLIER deadline
        // re-arms; a LATER one does not (the armed earlier timer fires spuriously and
        // re-arms -- that is the contract).
        const _setWithOpts = (key, v, o) => {
            // A null bag is tolerated (old 2-arg-era `set(k, v, null)` behaved as
            // a plain set), mirroring project(source, null). Non-null non-object
            // bags degrade to a plain set via undefined member reads.
            const ttl = o == null ? undefined : o.ttl;
            if (ttl === undefined) { _dropExp(_stage(key, v)); return; }
            if (!Number.isFinite(ttl) || ttl <= 0) {
                throw new TypeError("set: ttl must be a finite number > 0");
            }
            const d = _now() + ttl;
            if (!Number.isFinite(d)) {
                throw new TypeError("project: clock now() must return a finite number");
            }
            const s = _stage(key, v);
            if (s.exp === 0) ttlCount++;
            s.exp = d;
            if (timerHandle === null || d < armedAt) _armAt(d);
        };

        // Patch emission: iterate exactly the overlaid keys, handing scalars
        // (key, from, to) to `fn` -- `from` is the UNTRACKED current source value,
        // `to` the staged overlay. Read-only: overlays via .peek(), source under
        // untrack, so calling this inside an effect subscribes to nothing. The
        // visit set / order is byte-identical to forEachOverlay. Optional `skip`
        // reuses ReconcilePolicy: (from, to, key) => true drops that key from the
        // stream (e.g. `forEachPatch(fn, confirmOnEcho)` skips echoes); default
        // undefined emits every overlaid key, changed or not. A throwing
        // source.get propagates on the offending key with no writes anywhere, so
        // the overlay bag is intact by construction (fn may already have run for
        // earlier keys; callers needing atomicity use toPatch()).
        const forEachPatch = (fn, skip) => {
            for (const [key, s] of slots) {
                const to = s.ov.peek();
                if (to === ABSENT) continue;
                _pk = key;
                const from = untrack(_readSrc);
                if (skip !== undefined && skip(from, to, key)) continue;
                fn(key, from, to);
            }
        };

        // Hoisted scratch for forEachPatch's untracked source read: ONE closure
        // per projection, never per key/call, so the per-key emit body allocates
        // nothing. `untrack` needs a function; _readSrc is it.
        let _pk;
        const _readSrc = () => source.get(_pk);

        return {
            get: (key) => slotFor(key).read(),
            // Hot path (warm no-ttl): one arg load + !== undefined compare (not
            // taken), one _stage (identical work to the old body), one _dropExp
            // (one field load + !== 0 compare, not taken). Zero allocation, zero
            // branches taken. All ttl logic lives in the cold _setWithOpts. The
            // opts branch also STILL cancels a prior expiry (set(k,v,{}) -> plain).
            set: (key, v, opts) => {
                if (opts !== undefined) { _setWithOpts(key, v, opts); return; }
                const s = _stage(key, v);
                _dropExp(s);
            },
            clear: (key) => {
                const s = slots.get(key);
                if (s !== undefined && s.ov.peek() !== ABSENT) {
                    s.ov.set(ABSENT);
                    dirty--; dirtySig.set(dirty);
                    _dropExp(s);
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
            // Source fallthrough rides the hoisted _pk/_readSrc scratch (the
            // forEachPatch precedent): an inline untrack closure would capture
            // `key` and cost EVERY peek a context allocation -- including the warm
            // overlaid path that never takes the fallthrough.
            peek: (key) => {
                const s = slots.get(key);
                if (s === undefined) { _pk = key; return untrack(_readSrc); }
                const o = s.ov.peek();
                if (o !== ABSENT) return o;
                _pk = key;
                return untrack(_readSrc);
            },
            // Iterate currently-overlaid keys (untracked). Cold path.
            forEachOverlay: (fn) => {
                for (const [key, s] of slots) {
                    const o = s.ov.peek();
                    if (o !== ABSENT) fn(key, o);
                }
            },
            // Emit the overlaid keys as a patch stream fn(key, from, to). Untracked,
            // read-only, zero-alloc per-key body. See forEachPatch above.
            forEachPatch,
            // Cold convenience over forEachPatch: materialize the drafts as
            // [{ key, from, to }, ...] (same visit set, order, values). The
            // per-key record is the documented allocation of this form; reach for
            // forEachPatch when you need the zero-alloc callback.
            toPatch: (skip) => {
                const out = [];
                forEachPatch((key, from, to) => { out.push({ key, from, to }); }, skip);
                return out;
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
                            // _pk/_readSrc scratch (the forEachPatch precedent): an
                            // inline untrack closure would allocate per overlaid key.
                            _pk = key;
                            const authoritative = untrack(_readSrc);
                            if (pol(authoritative, o, key)) { s.ov.set(ABSENT); _dropExp(s); dropped++; }
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
                                dirty--; dirtySig.set(dirty); _dropExp(s);
                            }
                        }
                        return;
                    }
                    let changed = false;
                    for (const [k, s] of slots) {
                        const o = s.ov.peek();
                        if (o !== ABSENT) { source.set(k, o); s.ov.set(ABSENT); _dropExp(s); changed = true; }
                    }
                    if (changed) { dirty = 0; dirtySig.set(0); }
                });
            },
            revert: () => {
                batch(() => {
                    let changed = false;
                    for (const s of slots.values()) {
                        if (s.ov.peek() !== ABSENT) { s.ov.set(ABSENT); _dropExp(s); changed = true; }
                    }
                    if (changed) { dirty = 0; dirtySig.set(0); }
                });
            },
            // Predicate-scoped partial ops (S7). pred(key, stagedValue) -- the
            // forEachOverlay callback order, NOT ReconcilePolicy's. Visit slots in
            // insertion order, ONE batch, per-drop dirty bookkeeping so a throwing
            // pred leaves dirtyCount() === overlaidCount() (batch's finally still
            // flushes): already-committed keys stay committed, no rollback.
            commitWhere: (pred) => {
                if (typeof pred !== "function") throw new TypeError("commitWhere: pred must be a function");
                batch(() => {
                    for (const [k, s] of slots) {
                        const o = s.ov.peek();
                        if (o === ABSENT) continue;
                        if (!pred(k, o)) continue;
                        source.set(k, o);
                        s.ov.set(ABSENT); dirty--; dirtySig.set(dirty); _dropExp(s);
                    }
                });
            },
            clearWhere: (pred) => {
                if (typeof pred !== "function") throw new TypeError("clearWhere: pred must be a function");
                batch(() => {
                    for (const [k, s] of slots) {
                        const o = s.ov.peek();
                        if (o === ABSENT) continue;
                        if (!pred(k, o)) continue;
                        s.ov.set(ABSENT); dirty--; dirtySig.set(dirty); _dropExp(s);
                    }
                });
            },
            /**
             * Reclaim slots for keys that are no longer in use.
             *
             * A slot is created by the first READ of a key and retained until
             * dispose(), because its computed may have live subscribers. Over a
             * large or unbounded keyspace -- a virtualised list, a query whose
             * record churns, a projection driven by user input -- that is real
             * growth: 20,000 reads retained 60,000 nodes, and neither commit()
             * nor revert() gave any of them back.
             *
             * A slot is only safe to drop when it is BOTH un-overlaid (no staged
             * value to lose) and unobserved (no consumer's computed/effect is
             * subscribed to its read). `hasObservers` is what makes the second
             * half checkable; without it, pruning could dispose a computed out
             * from under a live subscriber.
             *
             * Cold path -- call it on a viewport change or after a commit, not
             * per frame. O(slots).
             *
             * @returns {number} how many slots were released.
             */
            prune: () => {
                if (typeof hasObservers !== "function") return 0;
                let n = 0;
                for (const [key, s] of slots) {
                    if (s.ov.peek() !== ABSENT) continue;      // a staged draft would be lost
                    // Only the READ computed's observers matter. `ov` is private to
                    // the slot and is always observed by that very computed, so
                    // testing it too would make prune() a permanent no-op.
                    if (hasObservers(s.read)) continue;        // a consumer is subscribed
                    dispose(s.read); dispose(s.ov);
                    slots.delete(key);
                    n++;
                }
                return n;
            },
            dispose: () => {
                // createRoot left these unowned, so nothing auto-disposes them.
                // Dispose the computed before its overlay so the read never re-evaluates
                // against a recycled signal.
                for (const s of slots.values()) { dispose(s.read); dispose(s.ov); }
                dispose(dirtySig);
                slots.clear();
                dirty = 0;
                // Cancel any pending TTL handle: a live setTimeout would hold the
                // event loop open for up to `ttl` ms and retain this closure (T6).
                _cancelTimer(); ttlCount = 0;
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
    hasObservers: _hasObservers,
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
export function projectStore(store, opts) {
    return project(fromProxy(store), opts);
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
    // Forward the flat opts bag: project reads only the clock keys (now/setTimer/
    // clearTimer); policy is consumed above and ignored there.
    const view = project(source, opts);
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

/**
 * Copy one own enumerable property WITHOUT going through assignment.
 * `out[k] = v` retargets the prototype when k is "__proto__" instead of creating
 * an own key, so the field silently vanishes. defineProperty creates a real own
 * key and leaves Object.prototype alone, so the merged record still has a normal
 * prototype for consumers that deepStrictEqual it.
 * @private
 */
function _put(out, k, v) {
    Object.defineProperty(out, k, { value: v, writable: true, enumerable: true, configurable: true });
}

/**
 * Default merge for projectQuery's commit.
 *
 * Iterates OWN keys only, symbols included. `for...in` was wrong on both counts:
 *
 *  - It walks the prototype chain. Combined with the assignment bug above, a
 *    draft field named "__proto__" did not merely disappear -- `overlays.__proto__
 *    = {pwned:1}` set the overlay bag's PROTOTYPE, and `for...in` then enumerated
 *    that object's keys, so committing a "__proto__" draft INJECTED `pwned` as a
 *    top-level field of the record. Own-keys iteration plus _put closes both ends.
 *  - It skips symbols. project() keys are PropertyKey and slots live in a Map, so
 *    a symbol-keyed draft staged fine, reported dirty, then evaporated on commit
 *    while dirtyCount fell to 0 -- a "saved" signal for a value that never landed.
 * @private
 */
const _ownEnumerableKeys = (o) => {
    const keys = Object.keys(o);
    const syms = Object.getOwnPropertySymbols(o);
    for (let i = 0; i < syms.length; i++) {
        if (Object.prototype.propertyIsEnumerable.call(o, syms[i])) keys.push(syms[i]);
    }
    return keys;
};

const _spreadMerge = (prev, overlays) => {
    const out = {};
    if (prev != null) {
        const pk = _ownEnumerableKeys(prev);
        for (let i = 0; i < pk.length; i++) _put(out, pk[i], prev[pk[i]]);
    }
    const ok = _ownEnumerableKeys(overlays);
    for (let i = 0; i < ok.length; i++) _put(out, ok[i], overlays[ok[i]]);
    return out;
};

/**
 * Project ONE @zakkster/lite-query entry's data object as a DRAFT overlay whose
 * projected keys are the FIELDS of that object. This is the optimistic-edit
 * layer for a fetched record: stage field drafts locally, then commit them back
 * into the query cache as a SINGLE `setQueryData` write (one cache mutation, one
 * broadcast, one refetch-eligible change) rather than one write per field.
 *
 *   - get(field)       reactive read: the draft if staged, else the query field
 *   - set(field, v)    stage a draft -- the query cache is NOT touched
 *   - commit(field?)   promote drafts into the cache via ONE setQueryData(key, prev
 *                      => merge(prev, overlays)); commit() writes all, commit(f) one
 *   - revert()         discard drafts
 *   - auto-reconcile   when `opts.data` is supplied, a refetch / external cache
 *                      write that the policy considers confirmed drops the matching
 *                      drafts; a CONFLICTING authoritative value leaves the draft
 *                      masked (the engine's Object.is short-circuit suppresses the
 *                      flicker), exactly as in projectRoom
 *
 * Reactivity depends on `opts.data`: pass the query's reactive data accessor
 * (e.g. `query.data` from lite-query's `createQuery`) so projected reads track
 * the cache and auto-reconcile is armed. WITHOUT it the adapter degrades to a
 * non-reactive `qc.getQueryData(key)` snapshot for the base read (drafts are
 * still reactive through their overlay signals, but the underlying record is not
 * tracked and there is no auto-reconcile).
 *
 * The query client is consumed structurally -- any object exposing
 * `getQueryData(key)` and `setQueryData(key, valueOrUpdater)` works -- so this
 * adapter adds no hard dependency on lite-query.
 *
 * @param {{getQueryData:Function, setQueryData:Function}} qc A lite-query client.
 * @param {PropertyKey|Array<unknown>} key The query key whose record is projected.
 * @param {{
 *   data?: () => (Record<PropertyKey, unknown> | null | undefined),
 *   policy?: (authoritative:unknown, draft:unknown, key:PropertyKey)=>boolean,
 *   merge?: (prev:(Record<PropertyKey,unknown>|null|undefined), overlays:Record<PropertyKey,unknown>)=>Record<PropertyKey,unknown>,
 * }} [opts]
 * @returns {object} A projection handle whose commit() writes the cache once and
 *          whose dispose() also stops the reconcile effect.
 */
export function projectQuery(qc, key, opts) {
    if (qc == null || typeof qc.getQueryData !== "function" || typeof qc.setQueryData !== "function") {
        throw new TypeError("projectQuery: qc must expose getQueryData(key) and setQueryData(key, valueOrUpdater)");
    }
    const data = opts && typeof opts.data === "function" ? opts.data : null;
    const policy = (opts && opts.policy) || confirmOnEcho;
    const merge = (opts && opts.merge) || _spreadMerge;

    // Reactive when `data` is supplied (tracks the query accessor); otherwise a
    // non-reactive cache peek. `set` is only reached if a caller drives the base
    // commit path directly; the overridden commit() below never uses it.
    const source = {
        get: (field) => {
            const rec = data ? data() : qc.getQueryData(key);
            return rec == null ? undefined : rec[field];
        },
        set: (field, v) => qc.setQueryData(key, (prev) => {
            const one = Object.create(null);
            _put(one, field, v);
            return merge(prev, one);
        }),
    };
    // Forward the flat opts bag: project reads only the clock keys (now/setTimer/
    // clearTimer); data/policy/merge are consumed above and ignored there.
    const view = project(source, opts);

    // Auto-reconcile: only meaningful when the record read is reactive. Tracks
    // `data()` (never the overlays), so clearing drafts inside reconcileAll does
    // not re-trigger it -> no loop. Mirrors projectRoom.
    const stopReconcile = data
        ? _effect(() => { data(); view.reconcileAll(policy); })
        : null;

    return {
        ...view,
        // One cache write for the whole burst of field drafts.
        commit: (field) => {
            if (field !== undefined) {
                if (!view.isOverlaid(field)) return;
                const v = view.peek(field);
                const one = Object.create(null);
                _put(one, field, v);
                qc.setQueryData(key, (prev) => merge(prev, one));
                view.clear(field);
                return;
            }
            // Null-prototype bag: `overlays["__proto__"] = v` on a plain object
            // sets the prototype instead of creating a key, which is how a
            // "__proto__" draft used to turn into field injection downstream.
            const overlays = Object.create(null);
            let any = false;
            view.forEachOverlay((f, v) => { _put(overlays, f, v); any = true; });
            if (!any) return;
            qc.setQueryData(key, (prev) => merge(prev, overlays));
            view.revert();
        },
        // Partial commit as ONE cache write (mirrors commit() above). NOT
        // view.commitWhere: that would issue one setQueryData per matching field,
        // breaking the single-write law. And NOT view.revert() after the write:
        // revert drops the NON-matching drafts too (silent data loss) and skips
        // per-key exp cancellation -- so clear ONLY the committed fields, in a
        // batch, which folds the N dirtySig writes into one propagation.
        commitWhere: (pred) => {
            if (typeof pred !== "function") throw new TypeError("commitWhere: pred must be a function");
            const overlays = Object.create(null);
            let any = false;
            view.forEachOverlay((f, v) => { if (pred(f, v)) { _put(overlays, f, v); any = true; } });
            if (!any) return;
            qc.setQueryData(key, (prev) => merge(prev, overlays));
            _batch(() => {
                const ks = _ownEnumerableKeys(overlays);
                for (let i = 0; i < ks.length; i++) view.clear(ks[i]);
            });
        },
        dispose: () => { if (stopReconcile) stopReconcile(); view.dispose(); },
    };
}

/**
 * Project a @zakkster/lite-crdt LWW-Map (`doc.map(name)`) as a per-key DRAFT
 * overlay for optimistic / tentative UI. Unlike projectRoom (which wraps
 * lite-room's COARSE storage -- one entries signal, any change re-runs every
 * projected key), an LWW-Map has FINE-GRAINED reactive `get(key)`, so this
 * adapter is truly granular: overlaying or committing one cell never re-runs a
 * consumer of another. The projection never joins the merge -- it only decides
 * what the local view tentatively overrides:
 *
 *   - set(key, value)  stage a draft -- local only, NOT synced, the CRDT untouched
 *   - commit(key?)     promote drafts via `map.set` (emits ops + syncs). One op
 *                      per committed key (N ops / N frames); LWW ops are
 *                      commutative + idempotent so N frames == 1 semantically.
 *                      Pass opts.transact (e.g. doc.transact) to coalesce a burst
 *                      into ONE ops frame + one change (commit and commitWhere both
 *                      wrap through it)
 *   - revert()         discard drafts
 *   - auto-reconcile   whenever an OVERLAID key's authoritative cell changes (local
 *                      echo or a remote applyOp), drafts the policy considers
 *                      confirmed are dropped; a CONFLICTING authoritative value --
 *                      including a concurrent authoritative DELETE (reads as
 *                      undefined) -- leaves the draft masked
 *
 * The map handle is consumed STRUCTURALLY: any object exposing a fine-grained
 * reactive `get(key)` and a `set(key, value)` works, so this adapter adds no hard
 * dependency on lite-crdt and never touches the doc, `map.store`, or the coarse
 * reads (keys/values/entries/size). The reconcile effect tracks exactly the
 * source cell of each currently-overlaid key (via `view.dirtyCount()` for the
 * overlay-set dependency + a bare `map.get(k)` per overlaid key), so it re-runs
 * on overlay-set transitions and on authoritative changes to overlaid keys only.
 *
 * -- READ-ONLY WRAPPER (object values), the recorded contract --
 * lite-crdt's `get(key)` returns a deep READ-ONLY WRAPPER for object/array values
 * (a different reference than the one passed to set), WeakMap-cached so it is
 * stable across reads. Two consequences: (1) confirmOnEcho (Object.is) can NEVER
 * auto-confirm an OBJECT-valued draft over projectCRDT, even on a genuine local
 * echo -- the wrapper breaks reference equality (scalars confirm normally); use a
 * {ttl} draft (the shipped heal) or a caller-supplied STRUCTURAL policy, whose
 * reads pass through the wrapper transparently. (2) A policy must NEVER attempt to
 * MUTATE the authoritative argument it is handed for an object value -- it is that
 * read-only wrapper and lite-crdt throws `readonly`.
 *
 * -- STRING-COERCION KEY ALIASING (caller hazard) --
 * lite-crdt coerces every map key to a string, but projection slots are keyed by
 * PropertyKey. So drafts on `5` and `"5"` (or a Symbol coerced elsewhere) are TWO
 * projection slots that commit into ONE CRDT cell -- last write wins, and
 * dirtyCount() never reveals the collision. Stage under ONE key type. A
 * `"__proto__"` map key is not usable in lite-crdt: `map.set` throws
 * CRDTError("misconfigured"). The adapter does NOT wrap that policy -- a commit of
 * a `"__proto__"` draft propagates the CRDT's own error with the draft still
 * staged and dirtyCount() consistent (fail closed).
 *
 * -- DISPOSE ORDER --
 * `doc.dispose()` makes subsequent mutations SILENT no-ops, so a commit AFTER the
 * doc is disposed writes nothing yet still clears the drafts (an inherited
 * dead-source data-loss class). Dispose the PROJECTION before the doc.
 *
 * @param {{get:(key:string)=>unknown, set:(key:string, value:unknown)=>void, delete?:(key:string)=>void}} map
 *        A lite-crdt LWW-Map (`doc.map(name)`) or any structural equivalent.
 * @param {{policy?: (authoritative:unknown, draft:unknown, key:string)=>boolean,
 *          transact?: <T>(fn:()=>T)=>T,
 *          now?:Function, setTimer?:Function, clearTimer?:Function}} [opts]
 *        Reconciliation policy (default confirmOnEcho), an optional transact hook
 *        that wraps commit/commitWhere, and the injectable overlay-TTL clock.
 * @returns {object} A projection handle whose dispose() also stops the reconcile effect.
 */
export function projectCRDT(map, opts) {
    if (map == null || typeof map.get !== "function" || typeof map.set !== "function") {
        throw new TypeError("projectCRDT: map must expose get(key) and set(key, value)");
    }
    const policy = (opts && opts.policy) || confirmOnEcho;
    // Fail closed: a supplied-but-not-a-function transact throws BEFORE any node
    // is created. The branch is resolved once here, never per commit call.
    const tx = opts && opts.transact !== undefined ? opts.transact : null;
    if (tx !== null && typeof tx !== "function") {
        throw new TypeError("projectCRDT: transact must be a function");
    }
    const source = { get: (k) => map.get(k), set: (k, v) => map.set(k, v) };
    // Forward the flat opts bag: project reads only the clock keys (now/setTimer/
    // clearTimer); policy/transact are consumed above and ignored there.
    const view = project(source, opts);

    // ONE hoisted per-adapter closure: forEachOverlay's callback, never a
    // per-run arrow. The second callback arg (the staged value) is ignored.
    const _trackSrc = (k) => { map.get(k); };
    const stopReconcile = _effect(() => {
        view.dirtyCount();                 // TRACKED: re-establishes deps on every overlay-set change
        view.forEachOverlay(_trackSrc);    // TRACKED map.get per overlaid key (overlay side peeks)
        view.reconcileAll(policy);         // untracked reads inside -> adds no deps
    });

    const commit = tx === null ? view.commit : (key) => { tx(() => view.commit(key)); };
    const commitWhere = tx === null ? view.commitWhere : (pred) => { tx(() => view.commitWhere(pred)); };
    return { ...view, commit, commitWhere, dispose: () => { stopReconcile(); view.dispose(); } };
}
