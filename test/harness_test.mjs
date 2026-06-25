// Harness / invariant tests for @zakkster/lite-project.
//
// The existing project_test.mjs is example-based: each test pins one scenario.
// That is necessary but, for a reactive overlay, not sufficient -- reactive
// systems fail at the seams between operations (interleavings, dynamic
// dependency edges, multi-key atomicity) that no single hand-written example
// exercises. This file adds the adversarial layer:
//
//   1. MODEL ORACLE FUZZ  -- thousands of random op sequences checked against a
//                            plain-Map reference model (the ground truth for
//                            overlay/source/commit/revert/reconcile semantics).
//   2. DYNAMIC DEPENDENCIES-- a consumer that switches which key it reads must
//                            unsubscribe from the key it abandoned.
//   3. ATOMICITY          -- commit / revert / reconcileAll touch many keys; a
//                            consumer must never observe a torn intermediate.
//   4. RECONCILE RACES    -- repeated / out-of-order echo+conflict converges.
//   5. DISPOSAL SAFETY     -- post-dispose the handle is inert and leak-free.
//
// IMPORTANT (registry discipline): lite-signal reactivity is per-registry. The
// projector is built on an isolated registry, so effects/signals MUST come from
// that SAME registry (reg.effect / reg.signal), exactly as project_test.mjs's
// fresh() helper does. Observing with the default-registry effect would never
// subscribe to the projection's computeds.
//
// Run: node --test test/harness_test.mjs   (needs @zakkster/lite-signal installed)

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";
import { createProjector, confirmOnEcho } from "../Project.js";

// Deterministic PRNG (mulberry32) so any failure is reproducible from the seed.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// A fresh isolated graph + projector per test. effect/signal are pulled from the
// SAME registry as the projector (see registry-discipline note above).
function freshProjector() {
    const reg = createRegistry();
    const { project, keyedStore } = createProjector(reg);
    return { reg, project, keyedStore, effect: reg.effect, signal: reg.signal, batch: reg.batch };
}

// ---------------------------------------------------------------------------
// 1. MODEL-ORACLE FUZZ
// ---------------------------------------------------------------------------
test("harness/oracle: random op sequences stay consistent with a Map model", () => {
    const SEEDS = [1, 2, 7, 42, 1337, 90210, 0xC0FFEE];
    const KEYS = ["a", "b", "c", "d", "e"];

    for (const seed of SEEDS) {
        const rand = rng(seed);
        const { project, keyedStore } = freshProjector();

        const sourceModel = new Map();
        const overlayModel = new Map();
        const seedEntries = {};
        for (const k of KEYS) { const v = "src0:" + k; seedEntries[k] = v; sourceModel.set(k, v); }

        const src = keyedStore(seedEntries);
        const p = project(src);

        const pick = () => KEYS[(rand() * KEYS.length) | 0];
        const effective = (k) => (overlayModel.has(k) ? overlayModel.get(k) : sourceModel.get(k));

        const OPS = 600;
        for (let i = 0; i < OPS; i++) {
            const r = rand();
            const k = pick();
            if (r < 0.34) {                       // set (stage overlay)
                const v = "ov" + i + ":" + k;
                p.set(k, v); overlayModel.set(k, v);
            } else if (r < 0.46) {                // clear one key
                p.clear(k); overlayModel.delete(k);
            } else if (r < 0.58) {                // authoritative source change
                const v = "src" + i + ":" + k;
                src.set(k, v); sourceModel.set(k, v);
            } else if (r < 0.74) {                // commit all
                p.commit();
                for (const [kk, vv] of overlayModel) sourceModel.set(kk, vv);
                overlayModel.clear();
            } else if (r < 0.86) {                // revert all
                p.revert(); overlayModel.clear();
            } else {                              // reconcileAll(confirmOnEcho)
                p.reconcileAll(confirmOnEcho);
                for (const kk of [...overlayModel.keys()]) {
                    if (confirmOnEcho(sourceModel.get(kk), overlayModel.get(kk))) overlayModel.delete(kk);
                }
            }

            let expectedOverlaid = 0;
            for (const k2 of KEYS) {
                assert.deepEqual(p.peek(k2), effective(k2),
                    `seed ${seed} op ${i}: peek(${k2}) diverged from model`);
                assert.equal(p.isOverlaid(k2), overlayModel.has(k2),
                    `seed ${seed} op ${i}: isOverlaid(${k2}) diverged`);
                if (overlayModel.has(k2)) expectedOverlaid++;
            }
            assert.equal(p.overlaidCount(), expectedOverlaid,
                `seed ${seed} op ${i}: overlaidCount diverged`);
        }
        p.dispose();
    }
});

// Reactive variant: a per-key consumer must always SEE the effective value
// (catches a stale projected read that peek() alone would miss).
test("harness/oracle: per-key consumers always reflect the effective value", () => {
    const KEYS = ["a", "b", "c"];
    const rand = rng(24601);
    const { project, keyedStore, effect } = freshProjector();

    const sourceModel = new Map();
    const overlayModel = new Map();
    const seedEntries = {};
    for (const k of KEYS) { seedEntries[k] = 0; sourceModel.set(k, 0); }
    const src = keyedStore(seedEntries);
    const p = project(src);

    const seen = {};
    for (const k of KEYS) effect(() => { seen[k] = p.get(k); });

    const effective = (k) => (overlayModel.has(k) ? overlayModel.get(k) : sourceModel.get(k));
    for (let i = 1; i <= 400; i++) {
        const k = KEYS[(rand() * KEYS.length) | 0];
        const r = rand();
        if (r < 0.4) { p.set(k, i); overlayModel.set(k, i); }
        else if (r < 0.6) { p.clear(k); overlayModel.delete(k); }
        else if (r < 0.8) { src.set(k, -i); sourceModel.set(k, -i); }
        else { p.revert(); overlayModel.clear(); }

        for (const k2 of KEYS) {
            assert.equal(seen[k2], effective(k2), `op ${i}: consumer(${k2}) stale`);
        }
    }
    p.dispose();
});

// ---------------------------------------------------------------------------
// 2. DYNAMIC DEPENDENCIES
// ---------------------------------------------------------------------------
test("harness/dynamic-deps: consumer unsubscribes from the branch it abandons", () => {
    const { project, keyedStore, effect, signal } = freshProjector();
    const src = keyedStore({ a: "a0", b: "b0" });
    const p = project(src);

    const cond = signal(true);
    let runs = 0;
    let seen;
    effect(() => { runs++; seen = cond() ? p.get("a") : p.get("b"); });

    assert.equal(runs, 1);
    assert.equal(seen, "a0");

    // b is NOT read on this branch -> mutating it must not re-run the consumer.
    p.set("b", "b1");
    assert.equal(runs, 1, "changing an unread key re-ran the consumer (over-subscription)");

    // flip to the b-branch -> one re-run, now sees b's overlay.
    cond.set(false);
    assert.equal(runs, 2);
    assert.equal(seen, "b1");

    // a is now abandoned -> mutating it must not re-run.
    p.set("a", "a99");
    assert.equal(runs, 2, "abandoned key still tracked (stale subscription not dropped)");

    // b is live -> mutating it re-runs.
    p.set("b", "b2");
    assert.equal(runs, 3);
    assert.equal(seen, "b2");

    p.dispose();
});

// ---------------------------------------------------------------------------
// 3. ATOMICITY
// ---------------------------------------------------------------------------
// commit() preserves EFFECTIVE values (each overlay value is written into the
// source, so overlay-then-source reads the same value): a projection consumer
// should observe NO change, and certainly no torn intermediate. revert() does
// change values (overlay -> source) but must do so as one transition. We assert
// the consumer actually ran during staging (guards against a vacuous test) and
// that neither op produces a torn snapshot.

function tornSnapshots(snapshots, finalExpected) {
    const total = Object.keys(finalExpected).length;
    const out = [];
    for (const s of snapshots) {
        const atFinal = Object.keys(finalExpected).filter((k) => s[k] === finalExpected[k]).length;
        if (atFinal > 0 && atFinal < total) out.push(s);   // some-but-not-all keys moved
    }
    return out;
}

test("harness/atomicity: commit() never exposes a torn snapshot to a projection consumer", () => {
    const { project, keyedStore, effect } = freshProjector();
    const src = keyedStore({ a: "A0", b: "B0", c: "C0" });
    const p = project(src);

    const snapshots = [];
    effect(() => { snapshots.push({ a: p.get("a"), b: p.get("b"), c: p.get("c") }); });

    p.set("a", "A1"); p.set("b", "B1"); p.set("c", "C1");
    assert.ok(snapshots.length >= 2, "wiring check: consumer must re-run as drafts are staged");
    snapshots.length = 0;                 // focus on the commit transition

    p.commit();

    assert.deepEqual(
        { a: p.peek("a"), b: p.peek("b"), c: p.peek("c") },
        { a: "A1", b: "B1", c: "C1" }, "post-commit effective values are wrong");
    assert.deepEqual(
        tornSnapshots(snapshots, { a: "A1", b: "B1", c: "C1" }), [],
        "projection consumer observed a torn (partially-committed) snapshot");

    p.dispose();
});

test("harness/atomicity: revert() of multiple drafts is one transition", () => {
    const { project, keyedStore, effect } = freshProjector();
    const src = keyedStore({ a: "A0", b: "B0", c: "C0" });
    const p = project(src);

    p.set("a", "A1"); p.set("b", "B1"); p.set("c", "C1");

    const snapshots = [];
    effect(() => { snapshots.push({ a: p.get("a"), b: p.get("b"), c: p.get("c") }); });
    snapshots.length = 0;

    p.revert();

    assert.deepEqual(
        { a: p.peek("a"), b: p.peek("b"), c: p.peek("c") },
        { a: "A0", b: "B0", c: "C0" });
    assert.deepEqual(
        tornSnapshots(snapshots, { a: "A0", b: "B0", c: "C0" }), [],
        "projection consumer observed a torn (partially-reverted) snapshot");

    p.dispose();
});

// ---------------------------------------------------------------------------
// 4. RECONCILE RACES
// ---------------------------------------------------------------------------
test("harness/reconcile: repeated echo+conflict on one key converges", () => {
    const { project, keyedStore } = freshProjector();
    const src = keyedStore({ k: "v0" });
    const p = project(src);

    p.set("k", "opt");
    assert.equal(p.peek("k"), "opt");
    assert.equal(p.isOverlaid("k"), true);

    src.set("k", "server-A");
    p.reconcileAll(confirmOnEcho);
    assert.equal(p.isOverlaid("k"), true, "conflicting echo wrongly dropped the draft");
    assert.equal(p.peek("k"), "opt", "draft should still mask the conflicting source");

    src.set("k", "server-B");
    p.reconcileAll(confirmOnEcho);
    assert.equal(p.isOverlaid("k"), true);
    assert.equal(p.peek("k"), "opt");

    src.set("k", "opt");
    p.reconcileAll(confirmOnEcho);
    assert.equal(p.isOverlaid("k"), false, "matching echo should confirm + drop the draft");
    assert.equal(p.peek("k"), "opt");

    p.dispose();
});

test("harness/reconcile: makeReconciler matches reconcileAll under a custom policy", () => {
    const { project, keyedStore } = freshProjector();
    const src = keyedStore({ n: 0 });
    const p = project(src);

    const policy = (auth, opt) => Number(auth) >= Number(opt);

    p.set("n", 5);
    src.set("n", 3);
    p.reconcileAll(policy);
    assert.equal(p.isOverlaid("n"), true, "auth(3) < opt(5): draft kept");

    src.set("n", 7);
    p.reconcileAll(policy);
    assert.equal(p.isOverlaid("n"), false, "auth(7) >= opt(5): draft confirmed");
    assert.equal(p.peek("n"), 7);

    p.dispose();
});

// ---------------------------------------------------------------------------
// 5. DISPOSAL SAFETY
// ---------------------------------------------------------------------------
test("harness/dispose: a disposed projection stops feeding live consumers", () => {
    const { project, keyedStore, effect } = freshProjector();
    const src = keyedStore({ a: "a0" });
    const p = project(src);

    let runs = 0;
    effect(() => { runs++; p.get("a"); });
    assert.equal(runs, 1);

    p.set("a", "a1");
    assert.equal(runs, 2);

    p.dispose();
    const before = runs;
    src.set("a", "a2");
    assert.equal(runs, before, "source change re-ran a consumer of a disposed projection");
});

test("harness/dispose: double dispose is a no-op (does not throw)", () => {
    const { project, keyedStore } = freshProjector();
    const src = keyedStore({ a: 1 });
    const p = project(src);
    p.get("a");
    p.dispose();
    assert.doesNotThrow(() => p.dispose());
});

// ---------------------------------------------------------------------------
// 6. DIRTY COUNTER  (reactive "unsaved changes" surface)
// ---------------------------------------------------------------------------
// dirtyCount()/isDirty() must track staged overlays across every mutation. The
// regression this guards: reconcileAll() dropping confirmed drafts WITHOUT
// decrementing the counter, leaving isDirty() stuck true.
test("harness/dirty: dirtyCount tracks staged overlays across set/clear/commit/revert/reconcile", () => {
    const { project, keyedStore, effect } = freshProjector();
    const src = keyedStore({ a: 0, b: 0, c: 0 });
    const p = project(src);

    // reactive observation -- proves dirtyCount() is tracked, not just a getter
    let runs = 0, last = -1;
    effect(() => { runs++; last = p.dirtyCount(); });
    assert.equal(p.dirtyCount(), 0);
    assert.equal(p.isDirty(), false);
    assert.equal(last, 0);

    p.set("a", 1);
    assert.equal(p.dirtyCount(), 1, "set stages one");
    assert.equal(p.isDirty(), true);
    p.set("a", 2);                         // re-set the same key
    assert.equal(p.dirtyCount(), 1, "re-setting an overlaid key does not double-count");
    p.set("b", 1);
    assert.equal(p.dirtyCount(), 2);
    assert.equal(last, 2, "dirtyCount is reactive");

    p.clear("a");
    assert.equal(p.dirtyCount(), 1, "clear drops one");
    p.clear("a");                          // clearing a non-overlaid key is a no-op
    assert.equal(p.dirtyCount(), 1, "clearing an already-clear key does not underflow");

    p.commit();                            // commits b
    assert.equal(p.dirtyCount(), 0, "commit resets dirty");

    p.revert();                            // nothing staged -> stays 0
    assert.equal(p.dirtyCount(), 0);

    // the regression: reconcileAll must decrement for dropped overlays
    p.set("b", 9);
    p.set("c", 5);
    assert.equal(p.dirtyCount(), 2);
    src.set("b", 9);                       // server echoes both (confirms)
    src.set("c", 5);
    p.reconcileAll(confirmOnEcho);
    assert.equal(p.isOverlaid("b"), false);
    assert.equal(p.isOverlaid("c"), false);
    assert.equal(p.dirtyCount(), 0, "reconcileAll must decrement dirty for each dropped overlay");
    assert.equal(last, 0, "dirtyCount reactive after reconcile");

    // partial reconcile: one confirmed, one still conflicting
    p.set("a", 7);
    p.set("b", 8);
    assert.equal(p.dirtyCount(), 2);
    src.set("a", 7);                       // a confirmed
    src.set("b", 999);                     // b conflicts -> kept
    p.reconcileAll(confirmOnEcho);
    assert.equal(p.isOverlaid("a"), false);
    assert.equal(p.isOverlaid("b"), true);
    assert.equal(p.dirtyCount(), 1, "only the confirmed draft decrements dirty");

    p.dispose();
});

// ---------------------------------------------------------------------------
// 7. SOURCE-SIDE ATOMICITY
// ---------------------------------------------------------------------------
// A consumer subscribed to the UNDERLYING source keys directly (other UI on the
// same lite-store/room keys, not going through the projection) must also see a
// multi-key commit() land as ONE transition. Without batch in commit() this
// consumer re-runs per source.set and observes partially-committed state; with
// batch it re-runs exactly once on the final snapshot.
test("harness/atomicity: commit() lands atomically for a direct source consumer", () => {
    const { project, keyedStore, effect } = freshProjector();
    const src = keyedStore({ a: "A0", b: "B0", c: "C0" });
    const p = project(src);

    // Subscribe to the SOURCE directly (keyedStore.get is a tracked read).
    const snapshots = [];
    effect(() => { snapshots.push({ a: src.get("a"), b: src.get("b"), c: src.get("c") }); });
    assert.equal(snapshots.length, 1, "source consumer runs once at creation");

    // Stage drafts on the projection -- the source is untouched, so the source
    // consumer must NOT re-run during staging.
    p.set("a", "A1"); p.set("b", "B1"); p.set("c", "C1");
    assert.equal(snapshots.length, 1, "staging drafts must not touch the source consumer");
    snapshots.length = 0;

    p.commit();                            // writes all three into the source

    assert.deepEqual(
        { a: src.get("a"), b: src.get("b"), c: src.get("c") },
        { a: "A1", b: "B1", c: "C1" }, "source did not receive the committed values");
    assert.equal(snapshots.length, 1, "commit must re-run the source consumer exactly once (one transition)");
    assert.deepEqual(
        tornSnapshots(snapshots, { a: "A1", b: "B1", c: "C1" }), [],
        "source consumer observed a torn (partially-committed) snapshot");

    p.dispose();
});
