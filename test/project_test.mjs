import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, signal as dSignal, isTracking as dIsTracking, effect as dEffect } from "@zakkster/lite-signal";
import { createProjector, fromProxy, makeReconciler, projectStore, projectRoom } from "../Project.js";

const CFG = { maxNodes: 256, maxLinks: 1024, prealloc: "eager", onCapacityExceeded: "grow" };
function fresh() {
    const reg = createRegistry(CFG);
    const { project, keyedStore } = createProjector(reg);
    return { reg, project, keyedStore };
}

test("get reflects source when not overlaid", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1);
    const p = project(store);
    assert.equal(p.get("a"), 1);
});

test("set overlays without mutating the source", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1);
    const p = project(store);
    p.set("a", 99);
    assert.equal(p.get("a"), 99);       // projection shows overlay
    assert.equal(store.get("a"), 1);    // source untouched
    assert.equal(p.isOverlaid("a"), true);
});

test("clear reverts one key to the source", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1);
    const p = project(store);
    p.set("a", 99); p.clear("a");
    assert.equal(p.get("a"), 1);
    assert.equal(p.isOverlaid("a"), false);
});

test("commit writes overlays into the source, then clears", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1); store.set("b", 2);
    const p = project(store);
    p.set("a", 77); p.set("b", 88);
    p.commit();
    assert.equal(store.get("a"), 77);
    assert.equal(store.get("b"), 88);
    assert.equal(p.overlaidCount(), 0);
});

test("revert drops all overlays", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1); store.set("b", 2);
    const p = project(store);
    p.set("a", 9); p.set("b", 9);
    assert.equal(p.overlaidCount(), 2);
    p.revert();
    assert.equal(p.overlaidCount(), 0);
    assert.equal(p.get("a"), 1);
    assert.equal(p.get("b"), 2);
});

test("granular: overlaying A does not re-run a consumer of B", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0); store.set("b", 0);
    const p = project(store);
    let cA = 0, cB = 0;
    reg.effect(() => { p.get("a"); cA++; });
    reg.effect(() => { p.get("b"); cB++; });
    assert.equal(cA, 1); assert.equal(cB, 1);
    p.set("a", 5);
    assert.equal(cA, 2, "A's consumer re-ran");
    assert.equal(cB, 1, "B's consumer did NOT re-run (granular)");
});

test("masking: a source change under an overlay does not churn the consumer", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0);
    const p = project(store);
    let cA = 0, last;
    reg.effect(() => { last = p.get("a"); cA++; });
    assert.equal(cA, 1); assert.equal(last, 0);

    p.set("a", 99);                       // optimistic overlay
    assert.equal(cA, 2); assert.equal(last, 99);

    store.set("a", 50);                   // source changes UNDER the overlay
    assert.equal(cA, 2, "masked -> projected value unchanged (99) -> Object.is short-circuit, NO re-run");
    assert.equal(last, 99);

    p.clear("a");                         // drop overlay -> reflects latest source
    assert.equal(cA, 3); assert.equal(last, 50);
});

test("ownership: the projected node survives the consumer effect's re-run (createRoot)", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0);
    const p = project(store);
    const trigger = reg.signal(0);
    let cA = 0, val;
    // This effect depends on BOTH `trigger` and the projected read. Its first run
    // lazily creates p's per-key computed. WITHOUT createRoot the effect would own
    // that computed and cascade-dispose it on the next re-run -> the projection breaks.
    reg.effect(() => { trigger(); val = p.get("a"); cA++; });
    assert.equal(cA, 1);

    trigger.set(1);                       // re-run the consumer
    assert.equal(cA, 2);

    // If the projected computed had been disposed by the re-run, this read would be
    // stale/undefined. It is not -> createRoot kept it alive.
    p.set("a", 42);
    assert.equal(cA, 3);
    assert.equal(val, 42);
    assert.equal(p.get("a"), 42);
});

test("ZERO-GC: overlay churn on warmed keys pulls no node from the pool", () => {
    const K = 256;
    const reg = createRegistry({ maxNodes: K * 4 + 64, maxLinks: K * 8 + 64, prealloc: "eager", onCapacityExceeded: "grow" });
    const { project, keyedStore } = createProjector(reg);
    const store = keyedStore();
    const p = project(store);
    const sink = new Float64Array(K);

    // Warm: source cells, projected slots, and a live consumer per key.
    for (let k = 0; k < K; k++) store.set(k, 0);
    for (let k = 0; k < K; k++) { const key = k; reg.effect(() => { sink[key] = p.get(key); }); }
    for (let k = 0; k < K; k++) { p.set(k, 0); p.clear(k); }   // settle slots

    const before = reg.stats();
    const M = 200000;
    for (let i = 0; i < M; i++) { const key = i % K; p.set(key, i); p.clear(key); }   // toggle on EXISTING keys
    const after = reg.stats();

    assert.equal(after.poolGrowths - before.poolGrowths, 0, "pool must not grow under steady-state overlay churn");
    assert.equal(after.totalAllocations - before.totalAllocations, 0, "no engine node pulled from the pool in the hot loop");

    let s = 0; for (let k = 0; k < K; k++) s += sink[k];       // anti-DCE
    assert.ok(Number.isFinite(s));
});

test("dispose recycles every projection-owned node", () => {
    const reg = createRegistry(CFG);
    const { project, keyedStore } = createProjector(reg);
    const store = keyedStore();
    const base = reg.stats().activeNodes;   // baseline BEFORE the projection exists
    const p = project(store);                // creates the projection's one fixed dirty signal
    for (let k = 0; k < 16; k++) { p.set(k, k); p.get(k); }     // 16 keys -> 16 overlay sigs + 16 computeds + 16 source cells
    assert.ok(reg.stats().activeNodes > base);
    p.dispose();
    // every projection-owned node is gone -- the per-key overlay sigs + projected
    // computeds AND the fixed dirty signal; only the store-owned source cells remain.
    assert.equal(reg.stats().activeNodes, base + 16, "only the 16 source cells remain after dispose");
});

// ---- integration layer -------------------------------------------------------

test("fromProxy: project over a property-style reactive source", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1);
    const proxy = new Proxy({}, {
        get: (_t, k) => store.get(k),
        set: (_t, k, v) => { store.set(k, v); return true; },
    });
    const p = project(fromProxy(proxy));
    assert.equal(p.get("a"), 1);
    p.set("a", 9);
    assert.equal(p.get("a"), 9);     // overlay
    assert.equal(proxy.a, 1);        // source (via proxy) untouched
    p.commit();
    assert.equal(proxy.a, 9);        // committed through the proxy setter
});

test("peek is untracked: reading it does not subscribe", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0);
    const p = project(store);
    let runs = 0, seen;
    reg.effect(() => { seen = p.peek("a"); runs++; });
    assert.equal(runs, 1); assert.equal(seen, 0);
    p.set("a", 5);
    assert.equal(runs, 1, "peek did not create a dependency");
});

test("makeReconciler: per-key event clears on echo, keeps on conflict", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0);
    const p = project(store);
    const onUpdate = makeReconciler(p);          // default echo policy
    p.set("a", 5);
    assert.equal(p.isOverlaid("a"), true);
    onUpdate("a", 3);                            // authoritative 3 != overlay 5
    assert.equal(p.isOverlaid("a"), true, "conflict -> overlay kept");
    onUpdate("a", 5);                            // authoritative 5 == overlay 5
    assert.equal(p.isOverlaid("a"), false, "echo -> overlay dropped");
});

test("reconcileAll: full-snapshot reconcile drops confirmed, keeps conflicting", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0); store.set("b", 0);
    const p = project(store);
    p.set("a", 5); p.set("b", 9);
    store.set("a", 5);                           // authoritative caught up to a
    p.reconcileAll();
    assert.equal(p.isOverlaid("a"), false, "a confirmed -> cleared");
    assert.equal(p.isOverlaid("b"), true, "b not confirmed -> kept");
});

test("room flow end-to-end: optimistic echo confirms; conflict stays masked", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0);   // authoritative (CRDT-owned)
    const p = project(store);
    const onUpdate = makeReconciler(p);
    let renders = 0, shown;
    reg.effect(() => { shown = p.get("a"); renders++; });   // the "UI"
    assert.equal(shown, 0);

    // optimistic local edit
    p.set("a", 5);
    assert.equal(shown, 5); assert.equal(store.get("a"), 0);   // instant echo, source untouched

    // server applies + echoes 5; room fires its update event
    store.set("a", 5); onUpdate("a", 5);
    assert.equal(p.isOverlaid("a"), false); assert.equal(p.get("a"), 5);

    // conflict: optimistic 9, authoritative resolves to 7
    const rBefore = renders;
    p.set("a", 9);
    store.set("a", 7);                            // authoritative diverges UNDER the overlay
    assert.equal(shown, 9, "masked: UI holds the optimistic value, no flicker to 7");
    onUpdate("a", 7);                             // 7 != 9 -> not confirmed
    assert.equal(p.isOverlaid("a"), true, "conflict overlay kept (app policy decides resolution)");
    assert.equal(p.get("a"), 9);
    assert.ok(renders >= rBefore);
});

// ---- gate scenario (for the full scavenge + scaling proof in zgc-scenarios.mjs) ----
// Drop into steadyScenarios. Each hot() iter toggles one overlay on a warmed key, so
// the scaling check (~0 scavenges at N and k*N, poolGrowthDelta 0, allocDelta 0) holds.
export function projectionChurnScenario(overrides = {}) {
    const K = (overrides.keys | 0) || 256;
    let reg = null, p = null, sink = null;
    return {
        name: `projection overlay churn (${K} warmed keys, toggle on existing)`,
        setup() {
            reg = createRegistry({ maxNodes: K * 4 + 64, maxLinks: K * 8 + 64, prealloc: "eager", onCapacityExceeded: "grow" });
            const { project, keyedStore } = createProjector(reg);
            const store = keyedStore();
            p = project(store);
            sink = new Float64Array(K);
            for (let k = 0; k < K; k++) store.set(k, 0);
            for (let k = 0; k < K; k++) { const key = k; reg.effect(() => { sink[key] = p.get(key); }); }
            for (let k = 0; k < K; k++) { p.set(k, 0); p.clear(k); }
            return { reg, p, K };
        },
        statsOf: (s) => s.reg.stats(),
        hot(s, n) { const pp = s.p, K = s.K; for (let i = 0; i < n; i++) { const key = i % K; pp.set(key, i); pp.clear(key); } },
        teardown(s) { s.reg.destroy(); reg = null; p = null; sink = null; },
    };
}

// ---- library adapter tests --------------------------------------------------
// Faithful stand-ins for the documented surfaces of @zakkster/lite-store v1.0.0
// and @zakkster/lite-room (full sources not on disk this session; the adapters
// in Project.js are written against the real APIs). Both stand-ins use the
// DEFAULT lite-signal registry, exactly as the real libraries do, so the
// default-bound projectStore / projectRoom interoperate with them.

// lite-store contract: a proxy with lazy per-key signals. A property becomes
// reactive (allocates + subscribes a signal) only when read under isTracking();
// a write fires the key's signal through Object.is. Matches lite-store's
// makeHandler get/set.
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
            if (dIsTracking()) cell(k)();           // lazy per-key subscribe
            return t[k];
        },
        set(t, k, v) {
            if (typeof k === "symbol") return Reflect.set(t, k, v);
            const old = t[k];
            if (Object.is(old, v)) return true;
            t[k] = v;
            const s = sigs.get(k);
            if (s !== undefined) s.set(v);          // fire if anyone tracked it
            return true;
        },
    });
}

// room.storage contract (LWW-Map): a single coarse `entries` signal that fires
// on any change; get(key) is a plain, NON-reactive Map read; set(key,value)
// applies and fires entries. Matches lite-room's storage surface.
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

test("projectStore: draft over a lite-store, commit writes through", () => {
    const s = makeLiteStoreLike({ name: "alice" });
    const p = projectStore(s);
    assert.equal(p.get("name"), "alice");
    p.set("name", "bob");
    assert.equal(p.get("name"), "bob");        // draft visible
    assert.equal(s.name, "alice");             // store untouched
    p.commit();
    assert.equal(s.name, "bob");               // committed through store[key]=
    assert.equal(p.isOverlaid("name"), false);
});

test("projectStore: granular + reactive over the store's per-key signals", () => {
    const s = makeLiteStoreLike({ a: 1, b: 1 });
    const p = projectStore(s);
    let cA = 0, cB = 0, lastA;
    const stopA = dEffect(() => { lastA = p.get("a"); cA++; });
    const stopB = dEffect(() => { p.get("b"); cB++; });
    assert.equal(cA, 1); assert.equal(cB, 1);
    s.a = 2;                                    // authoritative change to a
    assert.equal(lastA, 2);
    assert.equal(cA, 2, "a's consumer re-ran");
    assert.equal(cB, 1, "b's consumer did NOT (granular)");
    p.set("a", 99);
    assert.equal(p.get("a"), 99);              // draft overrides
    stopA(); stopB();
});

test("projectRoom: draft over room.storage, commit writes through to the CRDT", () => {
    const room = makeRoomLike();
    room.storage.set("title", "hello");        // authoritative
    const p = projectRoom(room);
    assert.equal(p.get("title"), "hello");
    p.set("title", "draft");                    // draft -- not synced
    assert.equal(p.get("title"), "draft");
    assert.equal(room.storage.get("title"), "hello");   // CRDT untouched
    p.commit();                                 // promote via room.storage.set
    assert.equal(room.storage.get("title"), "draft");
    assert.equal(p.isOverlaid("title"), false);
    p.dispose();
});

test("projectRoom: reconcile drops a draft when authoritative catches up (echo)", () => {
    const room = makeRoomLike();
    room.storage.set("k", 0);
    const p = projectRoom(room);
    p.set("k", 5);
    assert.equal(p.isOverlaid("k"), true);
    room.storage.set("k", 5);                   // authoritative echoes 5 -> reconcile drops draft
    assert.equal(p.isOverlaid("k"), false, "echo confirmed -> draft dropped");
    assert.equal(p.get("k"), 5);
    p.dispose();
});

test("projectRoom: a conflicting authoritative value leaves the draft masked", () => {
    const room = makeRoomLike();
    room.storage.set("k", 0);
    const p = projectRoom(room);
    let renders = 0, shown;
    const stop = dEffect(() => { shown = p.get("k"); renders++; });
    p.set("k", 9);
    assert.equal(shown, 9);
    room.storage.set("k", 7);                   // authoritative diverges UNDER the overlay
    assert.equal(p.isOverlaid("k"), true, "7 != 9 -> not confirmed -> kept");
    assert.equal(shown, 9, "masked: UI holds the optimistic value, no flicker to 7");
    assert.equal(p.get("k"), 9);
    stop(); p.dispose();
});

// ---- reactive dirty state + partial commit (1.0) ----------------------------

test("isDirty / dirtyCount are reactive and track presence transitions", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1); store.set("b", 2);
    const p = project(store);
    let runs = 0, dirty, count;
    reg.effect(() => { dirty = p.isDirty(); count = p.dirtyCount(); runs++; });
    assert.equal(runs, 1); assert.equal(dirty, false); assert.equal(count, 0);

    p.set("a", 10);                        // absent -> value: dirty
    assert.equal(dirty, true); assert.equal(count, 1); assert.equal(runs, 2);
    p.set("a", 11);                        // value -> value: presence unchanged, NO re-run
    assert.equal(count, 1); assert.equal(runs, 2);
    p.set("b", 20);                        // second key dirty
    assert.equal(count, 2); assert.equal(runs, 3);
    p.clear("a");                          // back to one dirty
    assert.equal(count, 1); assert.equal(runs, 4);
    p.revert();                            // all clean
    assert.equal(dirty, false); assert.equal(count, 0); assert.equal(runs, 5);
});

test("commit(key) writes one overlay through; others stay dirty", () => {
    const { project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 1); store.set("b", 2);
    const p = project(store);
    p.set("a", 10); p.set("b", 20);
    assert.equal(p.dirtyCount(), 2);
    p.commit("a");                         // partial commit
    assert.equal(store.get("a"), 10);      // a written through
    assert.equal(p.isOverlaid("a"), false);
    assert.equal(store.get("b"), 2);       // b untouched
    assert.equal(p.isOverlaid("b"), true);
    assert.equal(p.dirtyCount(), 1);       // only b remains dirty
    p.commit();                            // commit the rest
    assert.equal(store.get("b"), 20);
    assert.equal(p.dirtyCount(), 0);
});

test("dirtyCount drives a subscribed Save effect AND stays zero-GC under churn", () => {
    const { reg, project, keyedStore } = fresh();
    const store = keyedStore(); store.set("a", 0);
    const p = project(store);
    // The realistic wiring: a "Save enabled" effect subscribed to isDirty(). Every
    // toggle now marks + flushes a real subscriber -- prove it still allocates nothing.
    let saveEnabled = false, flips = 0;
    reg.effect(() => { saveEnabled = p.isDirty(); flips++; });
    p.set("a", 1); p.clear("a");           // warm the key's slot
    const base = reg.stats();
    for (let i = 0; i < 50000; i++) { p.set("a", i); p.clear("a"); }
    const after = reg.stats();
    assert.equal(after.poolGrowths - base.poolGrowths, 0, "no pool growth under 50k dirty toggles");
    assert.equal(after.totalAllocations - base.totalAllocations, 0, "no node allocations under 50k dirty toggles");
    assert.equal(p.dirtyCount(), 0);       // ended clean
    assert.equal(saveEnabled, false);
    assert.ok(flips > 100, "the Save effect actually re-ran on dirty transitions (" + flips + ")");
});
