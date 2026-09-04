// Patch-emission suite for @zakkster/lite-project 1.2 (forEachPatch / toPatch).
//
// forEachPatch(fn, skip?) emits the staged drafts as a (key, from, to) stream --
// `from` the UNTRACKED current source value, `to` the staged overlay -- over
// exactly the overlaid keys, in forEachOverlay order, subscribing to nothing.
// toPatch(skip?) is the cold convenience that materializes the same stream as
// [{ key, from, to }, ...]. Default policy EMITS unchanged drafts; pass
// confirmOnEcho to skip them. These tests use the default lite-signal registry
// (like the projectStore / projectRoom / projectQuery adapter suites) plus a
// fresh createRegistry for the core surface.
//
// Run: node --test test/patch_test.mjs

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

// Collect the callback stream into a plain array for comparison.
function stream(view, skip) {
    const out = [];
    view.forEachPatch((key, from, to) => { out.push({ key, from, to }); }, skip);
    return out;
}

// -- Visit set + order --------------------------------------------------------

test("forEachPatch visits exactly the overlaid keys, in forEachOverlay order", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1, b: 2, c: 3, d: 4 });
    const v = project(src);
    // Touch d then b then a as overlays; c is read (slot exists) but NOT overlaid.
    v.get("c");
    v.set("d", 40);
    v.set("b", 20);
    v.set("a", 10);

    const overlayKeys = [];
    v.forEachOverlay((k) => overlayKeys.push(k));
    const patchKeys = stream(v).map((p) => p.key);
    assert.deepEqual(patchKeys, overlayKeys, "patch visit set + order == forEachOverlay");
    assert.deepEqual(patchKeys, ["d", "b", "a"], "order is first-touch order");
    assert.equal(patchKeys.length, v.dirtyCount(), "one patch per dirty key");
    v.dispose();
});

// -- from / to correctness ----------------------------------------------------

test("from is the untracked source value, to is the staged overlay", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1 });
    const v = project(src);
    v.set("a", 99);
    const p = stream(v);
    assert.deepEqual(p, [{ key: "a", from: 1, to: 99 }]);
    v.dispose();
});

test("from tracks a source change made after the draft was staged", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1 });
    const v = project(src);
    v.set("a", 99);
    src.set("a", 7);                       // authoritative moves under the mask
    const p = stream(v);
    assert.deepEqual(p, [{ key: "a", from: 7, to: 99 }], "from is the CURRENT source value");
    v.dispose();
});

test("from is undefined for a never-set source key", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore();
    const v = project(src);
    v.set("fresh", 5);
    assert.deepEqual(stream(v), [{ key: "fresh", from: undefined, to: 5 }]);
    v.dispose();
});

// -- toPatch mirrors the callback stream --------------------------------------

test("toPatch() deep-equals the forEachPatch callback stream", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1, b: 2, c: 3 });
    const v = project(src);
    v.set("b", 20);
    v.set("a", 10);
    src.set("c", 30);
    v.set("c", 300);
    assert.deepEqual(v.toPatch(), stream(v));
    assert.deepEqual(v.toPatch(), [
        { key: "b", from: 2, to: 20 },
        { key: "a", from: 1, to: 10 },
        { key: "c", from: 30, to: 300 },
    ]);
    v.dispose();
});

test("toPatch() on a clean projection is empty", () => {
    const { project, keyedStore } = fresh();
    const v = project(keyedStore({ a: 1 }));
    v.get("a");
    assert.deepEqual(v.toPatch(), []);
    v.dispose();
});

// -- THE DECISION: unchanged drafts are emitted by default --------------------

test("unchanged draft is emitted by default", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1, b: 2 });
    const v = project(src);
    v.set("a", 1);                         // Object.is(from, to) -- unchanged
    v.set("b", 22);                        // changed
    const p = v.toPatch();
    assert.equal(p.length, 2, "the unchanged draft is NOT filtered");
    assert.equal(p.length, v.dirtyCount(), "toPatch().length == dirtyCount()");
    assert.deepEqual(p, [
        { key: "a", from: 1, to: 1 },
        { key: "b", from: 2, to: 22 },
    ]);
    v.dispose();
});

test("forEachPatch(fn, confirmOnEcho) skips unchanged drafts", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1, b: 2 });
    const v = project(src);
    v.set("a", 1);                         // unchanged -> skipped by echo policy
    v.set("b", 22);                        // changed   -> emitted
    assert.deepEqual(stream(v, confirmOnEcho), [{ key: "b", from: 2, to: 22 }]);
    assert.deepEqual(v.toPatch(confirmOnEcho), [{ key: "b", from: 2, to: 22 }]);
    assert.equal(v.dirtyCount(), 2, "the skip does not touch the bag");
    v.dispose();
});

test("skip receives (from, to, key)", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ a: 1, b: 2 });
    const v = project(src);
    v.set("a", 10);
    v.set("b", 20);
    const seen = [];
    v.forEachPatch(() => {}, (from, to, key) => { seen.push([from, to, key]); return false; });
    assert.deepEqual(seen, [[1, 10, "a"], [2, 20, "b"]]);
    v.dispose();
});

// -- Tracking contract --------------------------------------------------------

test("forEachPatch inside an effect subscribes to nothing", () => {
    // The effect MUST come from the same registry as the projection: lite-signal
    // tracking contexts are per-registry, so a default-registry effect could never
    // subscribe to a fresh-registry signal and the test would pass vacuously even
    // if forEachPatch read the source TRACKED. Use reg.effect.
    const { reg, project, keyedStore } = fresh();
    const src = keyedStore({ a: 1, b: 2 });
    const v = project(src);
    v.set("a", 10);
    let runs = 0;
    const stop = reg.effect(() => { runs++; v.forEachPatch(() => {}); });
    assert.equal(runs, 1, "effect ran once on creation");
    v.set("b", 20);                        // a later overlay change
    src.set("a", 999);                     // a later source write
    src.set("b", 888);
    assert.equal(runs, 1, "forEachPatch subscribed the effect to nothing");
    stop();
    v.dispose();
});

// -- Exotic keys --------------------------------------------------------------

test("__proto__, symbol, and numeric keys emit as ordinary drafts", () => {
    const { project, keyedStore } = fresh();
    const sym = Symbol("s");
    const src = keyedStore();
    const v = project(src);
    src.set("__proto__", "base");
    v.set("__proto__", "draft");
    v.set(sym, "symval");
    v.set(7, 700);
    const p = v.toPatch();
    assert.equal(p.length, 3);
    // Order is first-touch: __proto__, sym, 7.
    assert.equal(p[0].key, "__proto__");
    assert.equal(p[0].from, "base");
    assert.equal(p[0].to, "draft");
    assert.equal(p[1].key, sym);
    assert.equal(p[1].to, "symval");
    assert.equal(p[2].key, 7);
    assert.equal(p[2].from, undefined);
    assert.equal(p[2].to, 700);
    v.dispose();
});

// -- Degenerate values under Object.is ----------------------------------------

test("undefined / NaN / -0 drafts follow Object.is semantics", () => {
    const { project, keyedStore } = fresh();
    const src = keyedStore({ u: undefined, n: NaN, z: 0 });
    const v = project(src);
    v.set("u", undefined);                 // undefined == undefined -> unchanged
    v.set("n", NaN);                       // Object.is(NaN, NaN) -> unchanged
    v.set("z", -0);                        // Object.is(0, -0) === false -> changed
    // Default: all three emitted.
    assert.equal(v.toPatch().length, 3);
    // Echo policy drops u and n (Object.is true) but keeps z (0 !== -0).
    const kept = v.toPatch(confirmOnEcho);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].key, "z");
    assert.ok(Object.is(kept[0].from, 0));
    assert.ok(Object.is(kept[0].to, -0));
    v.dispose();
});

// -- Fail closed on a throwing source.get -------------------------------------

test("throwing source.get fails loud with the overlay bag intact", () => {
    const { project } = fresh();
    const backing = new Map([["a", 1], ["b", 2]]);
    const boom = new Error("source.get exploded");
    const v = project(fromAccessors(
        (k) => { if (k === "a" || k === "b") throw boom; return backing.get(k); },
        (k, x) => backing.set(k, x),
    ));
    v.set("a", 10);
    v.set("b", 20);
    const dc = v.dirtyCount();
    const oc = v.overlaidCount();
    assert.throws(() => v.forEachPatch(() => {}), /source\.get exploded/);
    // toPatch propagates the throw too, so no partial array escapes.
    assert.throws(() => v.toPatch(), /source\.get exploded/);
    assert.equal(v.dirtyCount(), dc, "dirtyCount unchanged after the throw");
    assert.equal(v.overlaidCount(), oc, "overlay bag intact");
    assert.equal(v.peek("a"), 10, "the staged overlay is still there");
    v.dispose();
});

// -- Metamorphic: patch-apply == commit at unit scale -------------------------

test("applying toPatch() to a source copy == commit() into the source", () => {
    const { project } = fresh();
    const backing = new Map([["a", 1], ["b", 2], ["c", 3]]);
    const v = project(fromAccessors((k) => backing.get(k), (k, x) => backing.set(k, x)));
    v.set("a", 10);
    v.set("c", 30);

    // Apply the patch to a fresh copy of the source.
    const copy = new Map(backing);
    for (const { key, to } of v.toPatch()) copy.set(key, to);

    // Commit into the real source.
    v.commit();

    assert.equal(copy.size, backing.size);
    for (const [k, val] of backing) {
        assert.ok(copy.has(k) && Object.is(copy.get(k), val),
            "patch-applied copy diverges from commit at " + String(k));
    }
    assert.equal(v.dirtyCount(), 0);
    v.dispose();
});

// -- Adapter exposure (all four handles) --------------------------------------

test("all four handles expose forEachPatch + toPatch as functions", () => {
    // core
    const { project, keyedStore } = fresh();
    const core = project(keyedStore({ a: 1 }));
    assert.equal(typeof core.forEachPatch, "function");
    assert.equal(typeof core.toPatch, "function");
    core.dispose();

    // projectStore (returns the core handle; methods are already there)
    const store = makeLiteStoreLike({ a: 1 });
    const ps = projectStore(store);
    assert.equal(typeof ps.forEachPatch, "function");
    assert.equal(typeof ps.toPatch, "function");
    ps.dispose();

    // projectRoom (spreads { ...view })
    const room = makeRoomLike();
    room.storage.set("k", "base");
    const pr = projectRoom(room);
    assert.equal(typeof pr.forEachPatch, "function");
    assert.equal(typeof pr.toPatch, "function");
    pr.dispose();

    // projectQuery (spreads { ...view })
    const qc = makeQueryClientLike({ rec: { name: "alice" } });
    const pq = projectQuery(qc, "rec", { data: qc.data("rec") });
    assert.equal(typeof pq.forEachPatch, "function");
    assert.equal(typeof pq.toPatch, "function");
    pq.dispose();
});

test("projectRoom: from is room.storage.get", () => {
    const room = makeRoomLike();
    room.storage.set("k", "authoritative");
    const pr = projectRoom(room);
    pr.set("k", "draft");
    assert.deepEqual(pr.toPatch(), [{ key: "k", from: "authoritative", to: "draft" }]);
    pr.dispose();
});

test("projectQuery: from is the cache record's FIELD value", () => {
    const qc = makeQueryClientLike({ rec: { name: "alice", age: 30 } });
    const pq = projectQuery(qc, "rec", { data: qc.data("rec") });
    pq.set("name", "bob");
    assert.deepEqual(pq.toPatch(), [{ key: "name", from: "alice", to: "bob" }]);
    pq.dispose();
});

// -- Stand-ins for the library adapters (faithful to documented surfaces) ------

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
            const e = entry(key);
            const next = typeof valueOrFn === "function" ? valueOrFn(e.value) : valueOrFn;
            e.value = next;
            e.sig.set(next);
            return next;
        },
        data: (key) => () => { const e = entry(key); e.sig(); return e.value; },
    };
    if (seed) for (const k in seed) qc.setQueryData(k, seed[k]);
    return qc;
}
