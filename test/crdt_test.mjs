// projectCRDT adapter suite for @zakkster/lite-project 1.4.
//
// projectCRDT(map, opts?) projects a @zakkster/lite-crdt LWW-Map (doc.map(name))
// as a per-key DRAFT overlay. Unlike projectRoom's coarse room.storage, an
// LWW-Map has FINE-GRAINED reactive get(key), so this adapter is truly granular.
// The adapter is default-registry-bound (like projectStore / projectRoom /
// projectQuery), and lite-crdt itself binds the DEFAULT lite-signal registry, so
// these tests run against the REAL package on the default registry.
//
// Run: node --test test/crdt_test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createCRDTDoc, CRDTError } from "@zakkster/lite-crdt";
import { effect as dEffect, signal as dSignal } from "@zakkster/lite-signal";
import { projectCRDT, confirmOnEcho } from "../Project.js";
import { makeFakeMap } from "./torture/harness.mjs";

// Deterministic fake clock (virtual time, one-handle counting): the flat bag
// project(source, opts) reads. advance() fires every due timer, re-scanning so a
// re-arm inside a fire is honoured. No real timers.
function makeClock() {
    let t = 0, nextId = 1, outstanding = 0;
    const timers = new Map();
    return {
        opts: {
            now: () => t,
            setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fireAt: t + ms, fn }); outstanding++; return id; },
            clearTimer: (id) => { if (timers.delete(id)) outstanding--; },
        },
        advance(ms) {
            t += ms;
            let ran = true;
            while (ran) {
                ran = false;
                for (const [id, tm] of timers) {
                    if (tm.fireAt <= t) { timers.delete(id); outstanding--; tm.fn(); ran = true; break; }
                }
            }
        },
        outstanding: () => outstanding,
    };
}

// -- op counter: staging is free; commit emits N ops / N frames ---------------

test("staging N keys emits 0 CRDT ops; commit emits N ops / N frames", () => {
    const doc = createCRDTDoc({ replicaId: "A" });
    const m = doc.map("m");
    let ops = 0, frames = 0;
    doc.on("op", () => ops++);
    doc.on("ops", () => frames++);
    const v = projectCRDT(m);
    v.set("a", 1); v.set("b", 2); v.set("c", 3);
    assert.equal(ops, 0, "staging never touches the CRDT");
    assert.equal(frames, 0);
    assert.equal(v.dirtyCount(), 3);
    v.commit();
    assert.equal(ops, 3, "one op per committed key");
    assert.equal(frames, 3, "no transact -> one frame per op");
    assert.equal(v.dirtyCount(), 0);
    v.dispose();
    doc.dispose();
});

test("opts.transact coalesces a commit burst into 3 ops / 1 frame", () => {
    const doc = createCRDTDoc({ replicaId: "B" });
    const m = doc.map("m");
    let ops = 0, frames = 0;
    doc.on("op", () => ops++);
    doc.on("ops", () => frames++);
    const v = projectCRDT(m, { transact: doc.transact });
    v.set("a", 1); v.set("b", 2); v.set("c", 3);
    v.commit();
    assert.equal(ops, 3, "still one op per key");
    assert.equal(frames, 1, "transact folds the burst into ONE ops frame");
    v.dispose();
    doc.dispose();
});

test("transact must be a function (fail closed before any node is created)", () => {
    const doc = createCRDTDoc({ replicaId: "B2" });
    const m = doc.map("m");
    assert.throws(() => projectCRDT(m, { transact: 5 }), /projectCRDT: transact must be a function/);
    doc.dispose();
});

// -- validation --------------------------------------------------------------

test("throws when map lacks get/set", () => {
    assert.throws(() => projectCRDT(null), /map must expose get\(key\) and set\(key, value\)/);
    assert.throws(() => projectCRDT({}), /map must expose get/);
    assert.throws(() => projectCRDT({ get() {} }), /map must expose get/);
});

// -- echo / conflict ---------------------------------------------------------

test("a scalar echo drops the draft; a conflict stays masked", () => {
    const doc = createCRDTDoc({ replicaId: "C" });
    const m = doc.map("m");
    m.set("k", 0);
    const v = projectCRDT(m);
    v.set("k", 5);
    assert.equal(v.isOverlaid("k"), true);
    m.set("k", 5);                                   // authoritative echoes
    assert.equal(v.isOverlaid("k"), false, "scalar echo dropped the draft");
    v.set("k", 9);
    m.set("k", 7);                                   // diverges under the overlay
    assert.equal(v.isOverlaid("k"), true, "7 != 9 -> kept masked");
    assert.equal(v.peek("k"), 9, "UI holds the optimistic value");
    v.dispose();
    doc.dispose();
});

// -- READ-ONLY WRAPPER pin (F-03 over projectCRDT) ---------------------------

test("wrapper pin: an object draft after a genuine local echo stays overlaid", () => {
    const doc = createCRDTDoc({ replicaId: "D" });
    const m = doc.map("m");
    m.set("k", { n: 0 });
    const v = projectCRDT(m);
    const draft = { n: 1 };
    v.set("k", draft);
    m.set("k", draft);                               // genuine local echo of the SAME reference
    // lite-crdt returns a deep read-only WRAPPER, so map.get("k") !== draft:
    // Object.is can never confirm an object draft. It stays overlaid.
    assert.equal(v.isOverlaid("k"), true, "wrapper breaks reference equality -> draft kept");
    v.dispose();
    doc.dispose();
});

test("wrapper pin: a structural policy DOES drop an object echo through the wrapper", () => {
    const doc = createCRDTDoc({ replicaId: "D2" });
    const m = doc.map("m");
    m.set("k", { n: 0 });
    const structural = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const v = projectCRDT(m, { policy: structural });
    v.set("k", { n: 1 });
    m.set("k", { n: 1 });                            // structural echo, new reference
    assert.equal(v.isOverlaid("k"), false, "structural policy reads through the wrapper transparently");
    v.dispose();
    doc.dispose();
});

// -- TTL heal over projectCRDT (injected clock through the opts bag) ----------

test("TTL heals a stuck object draft over projectCRDT (injected clock)", () => {
    const doc = createCRDTDoc({ replicaId: "E" });
    const m = doc.map("m");
    m.set("k", { n: 1 });
    const clock = makeClock();
    const v = projectCRDT(m, { ...clock.opts });
    v.set("k", { n: 1 }, { ttl: 50 });
    m.set("k", { n: 1 });                            // structural echo, new ref
    v.reconcileAll(confirmOnEcho);                   // Object.is -> stays masked
    assert.equal(v.isOverlaid("k"), true, "default policy keeps a wrapped object echo");
    clock.advance(50);
    assert.equal(v.isOverlaid("k"), false, "ttl healed the stuck object draft");
    assert.equal(clock.outstanding(), 0, "handle reclaimed after the fire");
    v.dispose();
    doc.dispose();
});

// -- STRING-COERCION KEY ALIASING pins ---------------------------------------

test("numeric alias: drafts on 5 and \"5\" are two slots that commit into one cell", () => {
    const doc = createCRDTDoc({ replicaId: "F" });
    const m = doc.map("m");
    const v = projectCRDT(m);
    v.set(5, "num");
    v.set("5", "str");
    assert.equal(v.dirtyCount(), 2, "two projection slots -- the collision is invisible to dirtyCount");
    v.commit();
    // Both slots committed into the one string-coerced cell "5"; last write wins.
    assert.equal(m.get("5"), "str", "the CRDT holds one cell, last write wins");
    v.dispose();
    doc.dispose();
});

test("symbol alias: a symbol-keyed draft commits String-coerced; the adapter never wraps the coercion", () => {
    const doc = createCRDTDoc({ replicaId: "G" });
    const m = doc.map("m");
    const v = projectCRDT(m);
    const sym = Symbol("s");
    v.set(sym, "x");
    assert.equal(v.isOverlaid(sym), true);
    v.commit(sym);                                   // lite-crdt String()-coerces the key
    assert.equal(m.get(String(sym)), "x", "landed in the CRDT under String(sym)");
    assert.equal(v.isOverlaid(sym), false, "draft cleared");
    v.dispose();
    doc.dispose();
});

// -- "__proto__" commit fail-closed ------------------------------------------

test("commit of a \"__proto__\" draft fails closed: CRDTError propagates, draft stays staged", () => {
    const doc = createCRDTDoc({ replicaId: "H" });
    const m = doc.map("m");
    const v = projectCRDT(m);
    v.set("__proto__", 1);
    assert.equal(v.isOverlaid("__proto__"), true);
    assert.equal(v.dirtyCount(), 1);
    let err = null;
    try { v.commit("__proto__"); } catch (e) { err = e; }
    assert.ok(err instanceof CRDTError, "the CRDT door's own error propagated (adapter did not wrap it)");
    assert.equal(v.isOverlaid("__proto__"), true, "the draft stayed staged after the throw");
    assert.equal(v.dirtyCount(), v.overlaidCount(), "dirtyCount consistent after the throw");
    assert.equal(v.dirtyCount(), 1);
    v.dispose();
    doc.dispose();
});

// -- granularity -------------------------------------------------------------

test("granularity: a consumer of view.get(\"b\") runs once across 10 commits to \"a\"", () => {
    const doc = createCRDTDoc({ replicaId: "I" });
    const m = doc.map("m");
    m.set("a", 0); m.set("b", 0);
    const v = projectCRDT(m);
    let runs = 0;
    const stop = dEffect(() => { v.get("b"); runs++; });
    assert.equal(runs, 1, "effect ran once on creation");
    for (let i = 0; i < 10; i++) { v.set("a", i); v.commit("a"); }
    assert.equal(runs, 1, "committing a never re-ran a consumer of b");
    stop(); v.dispose();
    doc.dispose();
});

test("granularity: the reconcile effect does not fire on non-overlaid-key writes", () => {
    const doc = createCRDTDoc({ replicaId: "J" });
    const m = doc.map("m");
    m.set("a", 0); m.set("c", 0);
    let calls = 0;
    const policy = (auth, ov) => { calls++; return Object.is(auth, ov); };
    const v = projectCRDT(m, { policy });
    assert.equal(calls, 0, "nothing overlaid at construction");
    v.set("a", 5);
    assert.equal(calls, 1, "overlaying a re-runs the reconcile effect once (a processed, kept)");
    m.set("c", 99);                                  // authoritative write to a NON-overlaid key
    assert.equal(calls, 1, "a write to a non-overlaid, untracked cell did NOT fire the reconcile effect");
    m.set("a", 1);                                   // authoritative write to the OVERLAID key
    assert.equal(calls, 2, "a write to the overlaid key's tracked cell fired the reconcile effect");
    assert.equal(v.isOverlaid("a"), true, "1 != 5 -> still masked");
    v.dispose();
    doc.dispose();
});

// -- missing-key draft -------------------------------------------------------

test("missing-key draft: toPatch reports from === undefined; commit creates the cell", () => {
    const doc = createCRDTDoc({ replicaId: "K" });
    const m = doc.map("m");
    const v = projectCRDT(m);
    v.set("new", 7);                                 // the CRDT never held "new"
    const patch = v.toPatch();
    assert.equal(patch.length, 1);
    assert.equal(patch[0].key, "new");
    assert.equal(patch[0].from, undefined, "from is undefined for a key the CRDT never held");
    assert.equal(patch[0].to, 7);
    v.commit("new");
    assert.equal(m.get("new"), 7, "commit created the cell");
    v.dispose();
    doc.dispose();
});

test("missing-key draft: a remote applyOp that creates the cell re-runs the projected read", () => {
    const doc = createCRDTDoc({ replicaId: "L" });
    const m = doc.map("m");
    const v = projectCRDT(m);
    let seen, runs = 0;
    const stop = dEffect(() => { seen = v.get("z"); runs++; });
    assert.equal(seen, undefined, "missing key reads as undefined");
    assert.equal(runs, 1);
    doc.applyOp({ t: "set", c: "m", k: "z", v: 99, l: 5, r: "Z" });   // remote creates z
    assert.equal(seen, 99, "the projected read re-evaluated when the cell appeared");
    assert.ok(runs >= 2);
    stop(); v.dispose();
    doc.dispose();
});

// -- authoritative-delete conflict -------------------------------------------

test("an authoritative delete of an overlaid key leaves the draft masked", () => {
    const doc = createCRDTDoc({ replicaId: "M" });
    const m = doc.map("m");
    m.set("k", "base");
    const v = projectCRDT(m);
    v.set("k", "draft");
    m.delete("k");                                   // authoritative delete -> reads as undefined
    assert.equal(v.isOverlaid("k"), true, "delete (undefined) != draft -> conflict, kept masked");
    assert.equal(v.peek("k"), "draft");
    v.dispose();
    doc.dispose();
});

// -- lifecycle ---------------------------------------------------------------

test("dispose stops the reconcile effect; a later map write is inert for this view", () => {
    const doc = createCRDTDoc({ replicaId: "N" });
    const m = doc.map("m");
    m.set("k", 0);
    const v = projectCRDT(m);
    v.set("k", 5);
    v.dispose();
    assert.doesNotThrow(() => m.set("k", 5), "a map write after dispose must not throw");
    assert.equal(v.isOverlaid("k"), false, "disposed view no longer holds slots");
    doc.dispose();
});

// -- fidelity: the harness fake matches the real LWW-Map on the scalar corpus ---

// One scalar corpus, recorded as a sequence of (isOverlaid a, isOverlaid b,
// dirtyCount, opCount) tuples. Run against both the real doc.map and the harness
// makeFakeMap: identical sequences prove the fake is a faithful stand-in (its own
// fidelity is an assertion, per the P3 spec).
function scalarCorpus(map, opCount) {
    const v = projectCRDT(map);
    const seq = [];
    const rec = () => seq.push([v.isOverlaid("a"), v.isOverlaid("b"), v.dirtyCount(), opCount()].join(","));
    map.set("a", 0); map.set("b", 0); rec();
    v.set("a", 5); rec();                             // stage a
    map.set("a", 5); rec();                           // scalar echo -> a dropped
    v.set("b", 9); rec();                             // stage b
    map.set("b", 7); rec();                           // conflict -> b masked
    v.commit("b"); rec();                             // promote b (one op)
    v.dispose();
    return seq;
}

test("fidelity: makeFakeMap and a real doc.map yield identical scalar-corpus sequences", () => {
    const doc = createCRDTDoc({ replicaId: "FID" });
    const rmap = doc.map("m");
    let rops = 0;
    doc.on("op", () => rops++);
    const real = scalarCorpus(rmap, () => rops);
    doc.dispose();

    const fmap = makeFakeMap({ signal: dSignal });
    const fake = scalarCorpus(fmap, fmap.opCount);

    assert.deepEqual(fake, real, "the harness fake diverged from the real LWW-Map on the scalar corpus");
});

test("commit after doc.dispose() writes nothing and still clears the drafts", () => {
    // The inherited dead-source hazard: doc.dispose() makes map.set a silent
    // no-op, but commit clears the draft unconditionally -- optimistic data loss.
    // Dispose the projection BEFORE the doc to avoid it.
    const doc = createCRDTDoc({ replicaId: "O" });
    const m = doc.map("m");
    m.set("k", "base");
    const v = projectCRDT(m);
    v.set("k", "draft");
    assert.equal(v.dirtyCount(), 1);
    doc.dispose();                                   // dead source
    v.commit("k");                                   // map.set is a silent no-op
    assert.equal(v.isOverlaid("k"), false, "the draft was cleared even though nothing was written");
    assert.equal(v.dirtyCount(), 0, "dirtyCount consistent after the dead-source commit");
    v.dispose();
});
