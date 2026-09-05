// Overlay TTL + partial commit suite for @zakkster/lite-project 1.3
// (set(key, v, {ttl}), the injectable clock, commitWhere / clearWhere).
//
// set(key, v, {ttl}) stages an overlay that auto-REVERTS at now()+ttl on a
// per-projection re-armed timer -- the source is never touched. The clock is
// injectable and all-or-none via project(source, {now, setTimer, clearTimer});
// a mixed clock is a TypeError. Every transition to ABSENT cancels that key's
// expiry. commitWhere(pred) / clearWhere(pred) apply a predicate-scoped partial
// save / discard, pred(key, stagedValue). These tests drive a DETERMINISTIC
// fake clock (no real timers) and, for the tracking claims, the effect of the
// SAME registry as the projection (lite-signal tracking is per-registry).
//
// Run: node --test test/ttl_test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    createRegistry,
    signal as dSignal,
    isTracking as dIsTracking,
} from "@zakkster/lite-signal";
import {
    createProjector,
    fromAccessors,
    confirmOnEcho,
    projectStore,
    projectRoom,
    projectQuery,
} from "../Project.js";

const CFG = { maxNodes: 256, maxLinks: 1024, prealloc: "eager", onCapacityExceeded: "grow" };
function fresh() {
    const reg = createRegistry(CFG);
    const { project, keyedStore } = createProjector(reg);
    return { reg, project, keyedStore };
}

// Deterministic fake clock: virtual time, counting outstanding handles. advance()
// fires every due timer (re-scanning after each so a re-arm inside a fire is
// honoured), so the projection's one-handle invariant is directly observable.
function makeClock() {
    let t = 0;
    let nextId = 1;
    let outstanding = 0;
    let maxOut = 0;
    const timers = new Map();               // id -> { fireAt, fn }
    return {
        opts: {
            now: () => t,
            setTimer: (fn, ms) => {
                const id = nextId++;
                timers.set(id, { fireAt: t + ms, fn });
                outstanding++;
                if (outstanding > maxOut) maxOut = outstanding;
                return id;
            },
            clearTimer: (id) => { if (timers.delete(id)) outstanding--; },
        },
        advance(ms) {
            t += ms;
            let ran = true;
            while (ran) {
                ran = false;
                for (const [id, tm] of timers) {
                    if (tm.fireAt <= t) {
                        timers.delete(id); outstanding--;
                        tm.fn();
                        ran = true;
                        break;                // re-scan: a re-arm may have added a handle
                    }
                }
            }
        },
        outstanding: () => outstanding,
        maxOutstanding: () => maxOut,
    };
}

// -- fire at / not-before the deadline ---------------------------------------

test("ttl overlay auto-reverts exactly at the deadline, not before", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("k", 5, { ttl: 10 });
    assert.ok(v.isOverlaid("k"), "draft staged");
    assert.equal(clock.outstanding(), 1, "one timer armed");
    clock.advance(9);
    assert.ok(v.isOverlaid("k"), "still overlaid before the deadline");
    assert.equal(v.dirtyCount(), 1);
    clock.advance(1);                                    // now at t=10 == deadline
    assert.ok(!v.isOverlaid("k"), "reverted at the deadline");
    assert.equal(v.dirtyCount(), 0, "dirtyCount cleared by the fire");
    assert.equal(clock.outstanding(), 0, "handle reclaimed after fire");
    assert.equal(Object.is(v.get("k"), 0), true, "reads fall back to source");
    v.dispose();
});

test("a fired ttl leaves the source byte-identical to its pre-set snapshot", () => {
    const { project } = fresh();
    const backing = new Map([["a", 1], ["b", 2]]);
    const clock = makeClock();
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => backing.set(k, x)), clock.opts);
    const snap = new Map(backing);
    v.set("a", 999, { ttl: 5 });
    clock.advance(5);
    assert.ok(!v.isOverlaid("a"), "expired");
    assert.equal(backing.size, snap.size, "source size unchanged");
    for (const [k, val] of snap) assert.ok(Object.is(backing.get(k), val), "source touched at " + k);
    v.dispose();
});

// -- re-arm semantics + one-handle invariant ---------------------------------

test("re-set with an earlier deadline re-arms; two ttls hold at most one handle", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 0, b: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("a", 1, { ttl: 10 });
    v.set("b", 2, { ttl: 20 });
    assert.equal(clock.maxOutstanding(), 1, "never more than one handle");
    clock.advance(10);
    assert.ok(!v.isOverlaid("a"), "a expired at 10");
    assert.ok(v.isOverlaid("b"), "b survives to 20");
    assert.equal(clock.outstanding(), 1, "re-armed for b");
    clock.advance(10);
    assert.ok(!v.isOverlaid("b"), "b expired at 20");
    assert.equal(clock.maxOutstanding(), 1, "one-handle invariant held throughout");
    v.dispose();
});

test("re-set with a LATER deadline is honoured (spurious early fire re-arms)", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("k", 1, { ttl: 5 });
    v.set("k", 2, { ttl: 100 });                         // extend the lifetime
    clock.advance(5);                                    // the earlier armed timer fires spuriously
    assert.ok(v.isOverlaid("k"), "later deadline honoured, not dropped at the old one");
    assert.equal(Object.is(v.peek("k"), 2), true);
    clock.advance(95);
    assert.ok(!v.isOverlaid("k"), "dropped at the true deadline");
    v.dispose();
});

// -- plain re-set cancels a prior expiry (T5) --------------------------------

test("re-set WITHOUT ttl cancels the pending expiry", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("k", 1, { ttl: 10 });
    v.set("k", 2);                                       // plain re-set -> cancels
    assert.equal(clock.outstanding(), 0, "plain re-set cancelled the timer");
    clock.advance(1000);
    assert.ok(v.isOverlaid("k"), "overlay survives past the old deadline");
    assert.equal(Object.is(v.peek("k"), 2), true);
    v.dispose();
});

test("set(k, v, {}) and set(k, v, {policy}) behave as plain set AND cancel a prior expiry", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("k", 1, { ttl: 10 });
    v.set("k", 2, {});                                   // empty bag == plain set
    assert.equal(clock.outstanding(), 0, "empty-bag re-set cancelled the timer");
    v.set("k", 3, { policy: "ignored" });               // unknown key ignored, still cancels
    assert.equal(clock.outstanding(), 0);
    clock.advance(1000);
    assert.ok(v.isOverlaid("k"), "overlay survives");
    assert.equal(Object.is(v.peek("k"), 3), true);
    v.dispose();
});

test("set(k, v, null) behaves as a plain set AND cancels a prior expiry", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("k", 1, { ttl: 10 });
    v.set("k", 2, null);                                 // old 2-arg-era null bag -> plain set
    assert.equal(clock.outstanding(), 0, "null-bag re-set cancelled the timer");
    clock.advance(1000);
    assert.ok(v.isOverlaid("k"), "overlay survives past the old deadline");
    assert.equal(Object.is(v.peek("k"), 2), true, "the new value is staged");
    assert.equal(v.dirtyCount(), 1, "dirtyCount consistent");
    v.dispose();
});

// -- every ABSENT transition cancels the expiry (S9) -------------------------

function assertCancelled(v, clock, label) {
    assert.equal(clock.outstanding(), 0, label + ": expiry not cancelled (handle outstanding)");
    const dc = v.dirtyCount();
    clock.advance(1_000_000);
    assert.equal(v.dirtyCount(), dc, label + ": advancing past a cancelled deadline moved dirtyCount");
}

test("clear cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    v.clear("k");
    assertCancelled(v, clock, "clear");
    v.dispose();
});

test("commit(key) cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    v.commit("k");
    assertCancelled(v, clock, "commit(key)");
    v.dispose();
});

test("commit() cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    v.commit();
    assertCancelled(v, clock, "commit()");
    v.dispose();
});

test("revert() cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    v.revert();
    assertCancelled(v, clock, "revert()");
    v.dispose();
});

test("reconcileAll drop cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("k", 5, { ttl: 10 });
    src.set("k", 5);                                     // authoritative echoes
    v.reconcileAll();                                   // confirmed -> drop
    assert.ok(!v.isOverlaid("k"));
    assertCancelled(v, clock, "reconcileAll");
    v.dispose();
});

test("commitWhere cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    v.commitWhere(() => true);
    assertCancelled(v, clock, "commitWhere");
    v.dispose();
});

test("clearWhere cancels a pending expiry", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    v.clearWhere(() => true);
    assertCancelled(v, clock, "clearWhere");
    v.dispose();
});

test("the fire itself cancels the expiry (no residual handle)", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    clock.advance(10);
    assertCancelled(v, clock, "fire");
    v.dispose();
});

// -- F-03: an object draft heals via ttl where reconcileAll left it masked ----

test("F-03: an object-valued draft that never echo-confirms self-heals on its ttl", () => {
    const { project } = fresh();
    const authoritative = { n: 1 };
    const backing = new Map([["k", authoritative]]);
    const clock = makeClock();
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => backing.set(k, x)), clock.opts);
    const twin = { n: 1 };                               // structurally equal, different ref
    v.set("k", twin, { ttl: 50 });
    backing.set("k", { n: 1 });                          // "echo" of a new reference
    v.reconcileAll(confirmOnEcho);                       // Object.is -> stays masked
    assert.ok(v.isOverlaid("k"), "default policy keeps a different-ref echo (F-03)");
    clock.advance(50);                                  // the TTL is the safety net
    assert.ok(!v.isOverlaid("k"), "ttl healed the stuck object draft");
    v.dispose();
});

// -- ttl validation (fail closed, before staging) ----------------------------

test("a bad ttl throws BEFORE staging and leaves the bag + source untouched", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ k: 7 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    for (const bad of [0, -1, NaN, Infinity, -Infinity, "5", null, true]) {
        assert.throws(() => v.set("k", 5, { ttl: bad }),
            /ttl must be a finite number > 0/, "ttl=" + String(bad) + " should throw");
    }
    assert.ok(!v.isOverlaid("k"), "no overlay staged by a rejected ttl");
    assert.equal(v.dirtyCount(), 0, "dirtyCount untouched");
    assert.equal(clock.outstanding(), 0, "no timer armed by a rejected ttl");
    assert.equal(Object.is(v.get("k"), 7), true, "source untouched");
    v.dispose();
});

// -- clock validation --------------------------------------------------------

test("a mixed (partial) clock is a TypeError", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore();
    const noop = () => {};
    assert.throws(() => project(src, { now: () => 0 }), /all-or-none clock/);
    assert.throws(() => project(src, { now: () => 0, setTimer: noop }), /all-or-none clock/);
    assert.throws(() => project(src, { setTimer: noop, clearTimer: noop }), /all-or-none clock/);
    assert.throws(() => project(src, { now: 5, setTimer: noop, clearTimer: noop }), /all-or-none clock/);
});

test("non-object opts is a TypeError; null / undefined use the default clock", () => {
    const { project, keyedStore } = fresh();
    assert.throws(() => project(keyedStore(), 5), /opts must be an object/);
    assert.throws(() => project(keyedStore(), "x"), /opts must be an object/);
    // null and undefined are accepted (default clock); no throw.
    const a = project(keyedStore(), null);
    const b = project(keyedStore(), undefined);
    a.dispose(); b.dispose();
});

// -- commitWhere / clearWhere: exact match + one propagation ------------------

test("commitWhere writes exactly the matching keys, leaves the rest staged", () => {
    const { project } = fresh();
    const backing = new Map([["a", 0], ["b", 0], ["c", 0]]);
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => backing.set(k, x)));
    v.set("a", 1); v.set("b", 2); v.set("c", 3);
    v.commitWhere((k) => k !== "b");                    // commit a and c, keep b
    assert.equal(backing.get("a"), 1, "a committed");
    assert.equal(backing.get("c"), 3, "c committed");
    assert.equal(backing.get("b"), 0, "b NOT committed");
    assert.ok(!v.isOverlaid("a") && !v.isOverlaid("c"), "committed keys cleared");
    assert.ok(v.isOverlaid("b"), "b still staged");
    assert.equal(v.dirtyCount(), 1);
    v.dispose();
});

test("commitWhere runs the dirtyCount effect exactly once extra (one propagation)", () => {
    const { reg, project } = fresh();
    const backing = new Map([["a", 0], ["b", 0], ["c", 0]]);
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => backing.set(k, x)));
    v.set("a", 1); v.set("b", 2); v.set("c", 3);
    let runs = 0;
    const stop = reg.effect(() => { runs++; v.dirtyCount(); });
    assert.equal(runs, 1, "effect ran once on creation");
    v.commitWhere(() => true);                          // three drops, ONE propagation
    assert.equal(runs, 2, "commitWhere coalesced into one propagation");
    stop(); v.dispose();
});

test("clearWhere drops matching keys with ZERO source writes, one propagation", () => {
    const { reg, project } = fresh();
    let writes = 0;
    const backing = new Map([["a", 0], ["b", 0]]);
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => { writes++; backing.set(k, x); }));
    v.set("a", 1); v.set("b", 2);
    let runs = 0;
    const stop = reg.effect(() => { runs++; v.dirtyCount(); });
    v.clearWhere(() => true);
    assert.equal(writes, 0, "clearWhere never writes the source");
    assert.equal(runs, 2, "one propagation");
    assert.equal(v.dirtyCount(), 0);
    stop(); v.dispose();
});

test("a throwing commitWhere pred leaves dirtyCount === overlaidCount; committed keys stay committed", () => {
    const { project } = fresh();
    const backing = new Map([["a", 0], ["b", 0], ["c", 0]]);
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => backing.set(k, x)));
    v.set("a", 1); v.set("b", 2); v.set("c", 3);
    const boom = new Error("pred exploded");
    // Throw on the SECOND visited key ("b"): "a" is already committed when it throws.
    assert.throws(() => v.commitWhere((k) => { if (k === "b") throw boom; return true; }), /pred exploded/);
    assert.equal(backing.get("a"), 1, "a stayed committed (no rollback)");
    assert.ok(!v.isOverlaid("a"), "a cleared");
    assert.equal(v.dirtyCount(), v.overlaidCount(), "bag consistent after the throw");
    assert.equal(v.dirtyCount(), 2, "b and c still staged");
    v.dispose();
});

test("commitWhere / clearWhere reject a non-function pred", () => {
    const { project, keyedStore } = fresh();
    const v = project(keyedStore());
    assert.throws(() => v.commitWhere(null), /commitWhere: pred must be a function/);
    assert.throws(() => v.clearWhere(5), /clearWhere: pred must be a function/);
    v.dispose();
});

// -- set-with-ttl inside a fire subscriber is honoured (T1) -------------------

test("a set(k, v, {ttl}) executed by a subscriber during the fire flush is honoured", () => {
    const { reg, project, keyedStore } = fresh();
    const src = keyedStore({ a: 0, b: 0 });
    const clock = makeClock();
    const v = project(src, clock.opts);
    v.set("a", 1, { ttl: 10 });                         // a overlaid, get("a") === 1
    let restaged = false;
    const stop = reg.effect(() => {
        const a = v.get("a");                            // subscribe to a's projected value
        if (a === 0 && !restaged) { restaged = true; v.set("b", 2, { ttl: 100 }); }
    });
    clock.advance(10);                                  // a fires -> effect re-runs -> stages b in-flush
    assert.ok(restaged, "the subscriber ran during the fire flush");
    assert.ok(v.isOverlaid("b"), "b staged during the flush");
    assert.equal(clock.maxOutstanding(), 1, "still at most one handle (T1)");
    assert.equal(clock.outstanding(), 1, "re-armed for b's deadline");
    clock.advance(100);
    assert.ok(!v.isOverlaid("b"), "b's ttl honoured");
    stop(); v.dispose();
});

// -- post-dispose fire is inert; dispose cancels the handle (T6) --------------

test("dispose cancels the pending handle; a post-dispose advance is inert", () => {
    const { project, keyedStore } = fresh();
    const clock = makeClock();
    const v = project(keyedStore({ k: 0 }), clock.opts);
    v.set("k", 5, { ttl: 10 });
    assert.equal(clock.outstanding(), 1);
    v.dispose();
    assert.equal(clock.outstanding(), 0, "dispose cancelled the timer");
    assert.doesNotThrow(() => clock.advance(1000), "post-dispose advance is inert");
});

// -- adapter coverage --------------------------------------------------------

test("projectStore forwards the clock; ttl reverts a store draft (store untouched)", () => {
    const store = makeLiteStoreLike({ name: "alice" });
    const clock = makeClock();
    const ps = projectStore(store, clock.opts);
    ps.set("name", "bob", { ttl: 10 });
    assert.equal(store.name, "alice", "store not mutated by the draft");
    assert.ok(ps.isOverlaid("name"));
    clock.advance(10);
    assert.ok(!ps.isOverlaid("name"), "draft expired");
    assert.equal(store.name, "alice", "store still authoritative after expiry");
    ps.dispose();
});

test("projectRoom forwards the clock; ttl reverts a room draft", () => {
    const room = makeRoomLike();
    room.storage.set("k", "base");
    const clock = makeClock();
    const pr = projectRoom(room, { ...clock.opts });
    pr.set("k", "draft", { ttl: 10 });
    assert.ok(pr.isOverlaid("k"));
    clock.advance(10);
    assert.ok(!pr.isOverlaid("k"), "room draft expired");
    assert.equal(room.storage.get("k"), "base", "room storage untouched");
    pr.dispose();
});

test("projectQuery.commitWhere is exactly ONE setQueryData write; non-matching drafts survive", () => {
    const qc = makeQueryClientLike({ rec: { a: 0, b: 0, c: 0 } });
    const pq = projectQuery(qc, "rec", { data: qc.data("rec") });
    pq.set("a", 1); pq.set("b", 2); pq.set("c", 3);
    const w0 = qc.writeCount();
    pq.commitWhere((f) => f !== "b");                   // commit a and c only
    assert.equal(qc.writeCount() - w0, 1, "exactly one cache write for N matching fields");
    const rec = qc.getQueryData("rec");
    assert.equal(rec.a, 1, "a landed in the cache");
    assert.equal(rec.c, 3, "c landed in the cache");
    assert.ok(!pq.isOverlaid("a") && !pq.isOverlaid("c"), "committed fields cleared");
    assert.ok(pq.isOverlaid("b"), "b's draft survived (no view.revert)");
    assert.equal(pq.dirtyCount(), 1, "dirtyCount === unmatched draft count");
    pq.dispose();
});

test("projectQuery forwards the clock; ttl reverts a field draft", () => {
    const qc = makeQueryClientLike({ rec: { a: 0 } });
    const clock = makeClock();
    const pq = projectQuery(qc, "rec", { data: qc.data("rec"), ...clock.opts });
    pq.set("a", 5, { ttl: 10 });
    assert.ok(pq.isOverlaid("a"));
    clock.advance(10);
    assert.ok(!pq.isOverlaid("a"), "field draft expired");
    assert.equal(qc.getQueryData("rec").a, 0, "cache untouched by the expired draft");
    pq.dispose();
});

// -- Stand-ins for the library adapters (faithful to documented surfaces) -----

function makeLiteStoreLike(initial) {
    const sigs = new Map();
    const target = { ...initial };
    const cell = (k) => {
        let s = sigs.get(k);
        if (s === undefined) { s = dSignal(target[k]); sigs.set(k, s); }
        return s;
    };
    return new Proxy(target, {
        get(t, k) {
            if (typeof k === "symbol") return Reflect.get(t, k);
            if (dIsTracking()) cell(k)();
            return t[k];
        },
        set(t, k, v) {
            if (typeof k === "symbol") return Reflect.set(t, k, v);
            if (Object.is(t[k], v)) return true;
            t[k] = v;
            const s = sigs.get(k);
            if (s !== undefined) s.set(v);
            return true;
        },
    });
}

function makeRoomLike() {
    const map = new Map();
    const entries = dSignal(map, { equals: () => false });
    return {
        storage: {
            set(key, value) { map.set(key, value); entries.set(map); return true; },
            get(key) { return map.get(key); },
            has(key) { return map.has(key); },
            entries,
        },
    };
}

function makeQueryClientLike(seed) {
    const cache = new Map();
    let writes = 0;
    const ks = (key) => JSON.stringify(key);
    const entry = (key) => {
        const k = ks(key);
        let e = cache.get(k);
        if (e === undefined) { e = { sig: dSignal(undefined, { equals: () => false }), value: undefined }; cache.set(k, e); }
        return e;
    };
    const qc = {
        getQueryData: (key) => entry(key).value,
        setQueryData: (key, valueOrFn) => {
            writes++;
            const e = entry(key);
            const next = typeof valueOrFn === "function" ? valueOrFn(e.value) : valueOrFn;
            e.value = next;
            e.sig.set(next);
            return next;
        },
        data: (key) => () => { const e = entry(key); e.sig(); return e.value; },
        writeCount: () => writes,
    };
    if (seed) for (const k in seed) qc.setQueryData(k, seed[k]);
    return qc;
}
