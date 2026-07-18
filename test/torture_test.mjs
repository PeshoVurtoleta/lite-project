/**
 * Torture / adversarial regression suite for @zakkster/lite-project.
 *
 * Each test pins a defect found during the v1.1.0 prepublish review, or a limit
 * that is deliberately NOT fixed and must not drift silently.
 *
 * Notes for anyone extending this file:
 *
 *  - THE INTERESTING FAILURES ARE SILENT ONES. Everything here that broke did so
 *    while reporting success: dirtyCount fell to 0, commit() returned normally,
 *    and the value simply was not in the record. Assert on the RECORD, never on
 *    the projection's own opinion of whether it saved.
 *
 *  - NODE-COUNT TESTS INSTALL A FIXED CEILING and use a node-free source
 *    (fromAccessors over a plain Map). keyedStore allocates a signal per key, so
 *    using it as the backing store makes the projection's own accounting
 *    impossible to read.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal, effect, createRegistry, setDefaultRegistry, stats } from "@zakkster/lite-signal";
import { project, projectQuery, fromAccessors, keyedStore, confirmOnEcho } from "../Project.js";

/* -- helpers ---------------------------------------------------------------- */

const ROOMY = { maxNodes: 1 << 18, maxLinks: 1 << 20, onCapacityExceeded: "grow" };
function inRegistry(config, fn) {
    setDefaultRegistry(createRegistry(config));
    try { return fn(); } finally { setDefaultRegistry(createRegistry(ROOMY)); }
}
setDefaultRegistry(createRegistry(ROOMY));

function mulberry32(a) {
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The structural query-client surface projectQuery documents. */
function makeQC(initial) {
    let store = initial;
    let writes = 0;
    const rev = signal(0);
    return {
        qc: {
            getQueryData: () => store,
            setQueryData: (_k, u) => { writes++; store = typeof u === "function" ? u(store) : u; rev.set(rev.peek() + 1); },
        },
        data: () => { rev(); return store; },
        raw: () => store,
        writes: () => writes,
    };
}

/** A backing store that allocates no reactive nodes of its own. */
const plainSource = (map) => fromAccessors((k) => map.get(k), (k, v) => map.set(k, v));

/* -- 1. Hostile field names in the commit merge ----------------------------- */

test("a draft named '__proto__' lands as a real own field", () => {
    // `out[k] = v` retargets the prototype for k === "__proto__" instead of
    // creating a key, so the draft evaporated on commit while dirtyCount fell to
    // 0 -- the projection reported "saved" for a value that never landed.
    const { qc, data, raw } = makeQC({ name: "ada" });
    const v = projectQuery(qc, "k", { data });
    v.set("name", "grace");
    v.set("__proto__", "staged");
    v.commit();
    const rec = raw();
    assert.ok(Object.prototype.hasOwnProperty.call(rec, "__proto__"), "'__proto__' draft was dropped");
    assert.equal(rec.__proto__, "staged");
    assert.equal(rec.name, "grace");
    assert.equal({}.staged, undefined, "Object.prototype polluted");
    v.dispose();
});

test("a '__proto__' draft does not INJECT its value's keys as fields", () => {
    // The nastier half. `overlays.__proto__ = {pwned:1}` set the overlay bag's
    // prototype, and the merge's `for...in` then enumerated that object's keys --
    // so committing produced a record with a top-level `pwned` field nobody
    // staged. Silent fabrication, not just silent loss.
    const { qc, data, raw } = makeQC({ name: "ada" });
    const v = projectQuery(qc, "k", { data });
    v.set("__proto__", { pwned: 1, evil: "yes" });
    v.commit();
    const rec = raw();
    assert.equal(rec.pwned, undefined, "commit fabricated a 'pwned' field from a __proto__ draft");
    assert.equal(rec.evil, undefined, "commit fabricated an 'evil' field from a __proto__ draft");
    assert.deepEqual(rec.__proto__, { pwned: 1, evil: "yes" }, "the draft itself should survive as a field");
    assert.equal(Object.getPrototypeOf(rec), Object.prototype, "record prototype was hijacked");
    assert.equal({}.pwned, undefined, "Object.prototype polluted");
    v.dispose();
});

test("single-field commit of '__proto__' behaves the same as commit-all", () => {
    const { qc, data, raw } = makeQC({ name: "ada" });
    const v = projectQuery(qc, "k", { data });
    v.set("__proto__", "staged");
    v.commit("__proto__");
    assert.ok(Object.prototype.hasOwnProperty.call(raw(), "__proto__"));
    assert.equal(raw().__proto__, "staged");
    v.dispose();
});

test("symbol-keyed drafts survive commit", () => {
    // project() keys are PropertyKey and slots live in a Map, so a symbol staged
    // fine and reported dirty -- then the merge's `for...in` skipped it and
    // dirtyCount fell to 0 anyway.
    const F = Symbol("field");
    const { qc, data, raw } = makeQC({ name: "ada" });
    const v = projectQuery(qc, "k", { data });
    v.set(F, "sym-value");
    assert.equal(v.dirtyCount(), 1);
    v.commit();
    assert.equal(raw()[F], "sym-value", "symbol draft was silently dropped by the merge");
    assert.equal(v.dirtyCount(), 0);
    v.dispose();
});

test("the merge copies own properties only, not inherited ones", () => {
    const proto = { inherited: "should not appear" };
    const prev = Object.create(proto);
    prev.real = 1;
    const { qc, data, raw } = makeQC(prev);
    const v = projectQuery(qc, "k", { data });
    v.set("added", 2);
    v.commit();
    assert.equal(raw().real, 1);
    assert.equal(raw().added, 2);
    assert.ok(!Object.prototype.hasOwnProperty.call(raw(), "inherited"),
        "merge copied an inherited property into the record");
    v.dispose();
});

test("a hostile record from the cache cannot pollute on read or commit", () => {
    const hostile = JSON.parse('{"name":"ada","__proto__":{"pwned":1}}');
    const { qc, data, raw } = makeQC(hostile);
    const v = projectQuery(qc, "k", { data });
    v.set("name", "grace");
    assert.doesNotThrow(() => v.commit());
    assert.equal({}.pwned, undefined, "Object.prototype polluted");
    assert.equal(raw().name, "grace");
    v.dispose();
});

test("the merged record keeps an ordinary prototype", () => {
    // Guard against 'fixing' __proto__ by making the record null-prototype: that
    // would silently break every consumer asserting deepStrictEqual against a
    // plain object literal.
    const { qc, data, raw } = makeQC({ a: 1 });
    const v = projectQuery(qc, "k", { data });
    v.set("b", 2);
    v.commit();
    assert.deepStrictEqual(raw(), { a: 1, b: 2 });
    v.dispose();
});

/* -- 2. prune(): reclaiming slots without breaking live consumers ----------- */

test("prune() releases slots for keys nobody is using", () => {
    inRegistry({ maxNodes: 1 << 16 }, () => {
        const v = project(plainSource(new Map()));
        const base = stats().activeNodes;
        for (let i = 0; i < 2000; i++) v.get("k" + i);
        const grown = stats().activeNodes - base;
        assert.ok(grown >= 2000, `reads should allocate per-key slots, saw ${grown}`);
        const released = v.prune();
        assert.equal(released, 2000, "prune() left slots behind");
        assert.ok(stats().activeNodes - base < 10, "prune() did not return the nodes");
        v.dispose();
    });
});

test("prune() never drops an observed or an overlaid slot", () => {
    const v = project(plainSource(new Map([["watched", "w"]])));
    for (let i = 0; i < 50; i++) v.get("cold" + i);
    const stop = effect(() => { v.get("watched"); });
    v.set("staged", 1);
    const released = v.prune();
    assert.equal(released, 50, "prune() should have released exactly the cold slots");
    assert.equal(v.get("watched"), "w", "an observed slot was pruned out from under its consumer");
    assert.equal(v.isOverlaid("staged"), true, "a staged draft was discarded by prune()");
    assert.equal(v.peek("staged"), 1);
    assert.equal(v.dirtyCount(), 1, "prune() corrupted the dirty counter");
    stop(); v.dispose();
});

test("a pruned key still reads correctly afterwards", () => {
    const backing = new Map([["a", 1]]);
    const v = project(plainSource(backing));
    assert.equal(v.get("a"), 1);
    assert.equal(v.prune(), 1);
    backing.set("a", 2);
    assert.equal(v.get("a"), 2, "reading a pruned key must rebuild its slot transparently");
    assert.equal(v.prune(), 1);
    v.dispose();
});

/* -- 3. Accounting and lifecycle -------------------------------------------- */

test("dirtyCount tracks overlaidCount through an adversarial sequence", () => {
    const src = keyedStore({ a: 1, b: 2 });
    const v = project(src);
    const stop = effect(() => { v.dirtyCount(); });
    const agree = (label) => assert.equal(v.dirtyCount(), v.overlaidCount(), `desync after ${label}`);
    v.set("a", 10); agree("set a");
    v.set("a", 11); agree("re-set a");
    v.clear("a"); agree("clear a");
    v.clear("a"); agree("clear a again");
    v.set("b", 20); v.commit("b"); agree("commit one");
    v.commit("b"); agree("commit one again");
    v.set("a", 1); v.reconcileAll(); agree("reconcileAll echo");
    v.set("a", 9); v.set("b", 8); v.revert(); agree("revert");
    v.set("c", 5); v.commit(); agree("commit all");
    assert.equal(v.dirtyCount(), 0);
    stop(); v.dispose();
});

test("400 seeds of randomised overlay editing keep view and accounting honest", () => {
    const KEYS = ["a", "b", "c", "d"];
    for (let seed = 1; seed <= 400; seed++) {
        const rnd = mulberry32(seed);
        // A REACTIVE source: plainSource is a bare Map, so writing it directly
        // fires nothing and the projected computed keeps a stale cached value.
        // The authoritative-change branch below needs the source to be reactive
        // for the oracle to mean anything.
        const oracle = new Map(KEYS.map((k, i) => [k, i]));
        const backing = keyedStore(Object.fromEntries(oracle));
        const drafts = new Map();                 // staged overlays
        const v = project(backing);
        const stop = effect(() => { v.dirtyCount(); });

        for (let o = 0; o < 60; o++) {
            const k = KEYS[(rnd() * KEYS.length) | 0];
            const roll = rnd();
            if (roll < 0.35) { const val = (rnd() * 100) | 0; v.set(k, val); drafts.set(k, val); }
            else if (roll < 0.5) { v.clear(k); drafts.delete(k); }
            else if (roll < 0.65) {
                v.commit(k);
                if (drafts.has(k)) { oracle.set(k, drafts.get(k)); drafts.delete(k); }
            } else if (roll < 0.75) {
                v.commit();
                for (const [dk, dv] of drafts) oracle.set(dk, dv);
                drafts.clear();
            } else if (roll < 0.85) { v.revert(); drafts.clear(); }
            else if (roll < 0.92) {
                v.reconcileAll(confirmOnEcho);
                for (const [dk, dv] of [...drafts]) if (Object.is(oracle.get(dk), dv)) drafts.delete(dk);
            } else {
                const val = (rnd() * 100) | 0;
                backing.set(k, val); oracle.set(k, val);   // authoritative change (fires the cell)
            }

            assert.equal(v.dirtyCount(), drafts.size, `seed ${seed} op ${o}: dirtyCount`);
            assert.equal(v.overlaidCount(), drafts.size, `seed ${seed} op ${o}: overlaidCount`);
            for (const key of KEYS) {
                const want = drafts.has(key) ? drafts.get(key) : oracle.get(key);
                assert.equal(v.peek(key), want, `seed ${seed} op ${o}: peek(${key})`);
                assert.equal(v.get(key), want, `seed ${seed} op ${o}: get(${key})`);
            }
        }
        stop(); v.dispose();
    }
});

test("dispose() returns every node the projection took", () => {
    inRegistry({ maxNodes: 1 << 15 }, () => {
        const base = stats().activeNodes;
        for (let i = 0; i < 50; i++) {
            const v = project(plainSource(new Map([["a", 1]])));
            const stop = effect(() => { v.get("a"); v.isDirty(); });
            v.set("a", i); v.commit();
            v.get("b"); v.get("c");
            stop(); v.dispose();
        }
        assert.equal(stats().activeNodes, base, "project() create/dispose cycles leaked nodes");
    });
});

/* -- 4. projectQuery behaviour under a live reconcile effect ---------------- */

test("a multi-field commit is exactly ONE cache write", () => {
    const { qc, data, raw, writes } = makeQC({ a: 1, b: 2, c: 3 });
    const v = projectQuery(qc, "k", { data });
    const stop = effect(() => { v.get("a"); v.get("b"); });
    v.set("a", 10); v.set("b", 20); v.set("c", 30);
    const before = writes();
    v.commit();
    assert.equal(writes() - before, 1, "commit() fanned out into multiple cache writes");
    assert.deepEqual(raw(), { a: 10, b: 20, c: 30 });
    assert.equal(v.dirtyCount(), 0);
    stop(); v.dispose();
});

test("a conflicting authoritative write stays masked; an echo drops the draft", () => {
    const { qc, data } = makeQC({ a: 1 });
    const v = projectQuery(qc, "k", { data });
    const seen = [];
    const stop = effect(() => { seen.push(v.get("a")); });
    v.set("a", 99);
    qc.setQueryData("k", () => ({ a: 42 }));      // server disagrees
    assert.equal(v.isOverlaid("a"), true, "draft was dropped by a CONFLICTING value");
    assert.equal(v.peek("a"), 99);
    assert.ok(!seen.includes(42), "the conflicting value flickered through to the consumer");
    qc.setQueryData("k", () => ({ a: 99 }));      // server echoes
    assert.equal(v.isOverlaid("a"), false, "draft survived an echoing authoritative value");
    assert.equal(v.dirtyCount(), 0);
    stop(); v.dispose();
});

test("a throwing source leaves the projection internally consistent", () => {
    let boom = false;
    const backing = new Map([["a", 1]]);
    const v = project(fromAccessors(
        (k) => { if (boom && k === "a") throw new Error("source exploded"); return backing.get(k); },
        (k, val) => backing.set(k, val),
    ));
    const stop = effect(() => { try { v.get("a"); } catch { /* consumer guards */ } });
    v.set("a", 5);
    boom = true;
    try { v.commit(); } catch { /* the read-side throw may escape */ }
    boom = false;
    assert.equal(v.dirtyCount(), v.overlaidCount(), "dirty accounting desynced after a source throw");
    assert.equal(backing.get("a"), 5, "the commit's write did not land");
    stop(); v.dispose();
});

/* -- 5. Documented limits -- pinned, NOT fixed ------------------------------- */

test("LIMIT: reading a key allocates a slot that outlives commit and revert", () => {
    // A slot is created by the first READ and retained because its computed may
    // have subscribers. commit()/revert() clear overlays but reclaim nothing, so
    // an unbounded keyspace grows until dispose() -- or, now, prune().
    inRegistry({ maxNodes: 1 << 15 }, () => {
        const v = project(plainSource(new Map()));
        const base = stats().activeNodes;
        for (let i = 0; i < 500; i++) v.get("k" + i);
        const afterReads = stats().activeNodes - base;
        v.revert(); v.commit();
        assert.equal(stats().activeNodes - base, afterReads,
            "commit/revert now reclaim slots -- if that is intended, replace this pin");
        assert.ok(v.prune() > 0, "prune() is the supported way to reclaim them");
        v.dispose();
    });
});
