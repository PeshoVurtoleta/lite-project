/**
 * T7 -- soak, retention, conservation.
 *
 * 4096 build/tear-down cycles with a lite-leak tracker: after each cycle a cheap
 * corpus is validated and the view disposed. The cleanup thunk and the tag NEVER
 * close over the tracked view -- capturing the target defeats finalization and
 * the tracker silently reports clean. After the soak, two globalThis.gc() + ~50ms
 * settle passes drive the FinalizationRegistry before reading size()/audit().
 *
 * A separate prune-bound sub-soak (the only place TrackOptions audit:true is
 * used -- it retains one owner-pool slot per handle, so it never runs on the
 * 4096-cycle loop) proves prune() reclaims O(reads) slots off an unbounded read
 * pattern and a pruned key rebuilds transparently on the next read. dispose()
 * leaves tracker.size()===0 and the node census back at baseline (F-04 witnessed).
 */
import { createLeakTracker } from "@zakkster/lite-leak";
import { signal } from "@zakkster/lite-signal";
import { project, projectCRDT, fromAccessors } from "../../Project.js";
import { SEED, makePrng, frac, check, makeOracle, validate, graphSnapshot, graphDelta, metrics, makeFakeClock, makeFakeMap } from "./harness.mjs";

const CYCLES = 4096;
const KEYS = ["a", "b", "c", "d"];

function settle(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Module-level cleanup: bumps a counter, closes over NOTHING (held-value
// contract). The view is disposed manually in the loop; this is the finalizer
// that would run if a view ever outlived its cycle.
let cleanupCount = 0;
function t7Cleanup() { cleanupCount++; }

export async function run() {
    const base = graphSnapshot();

    // onLeak fires on EVERY finalization of a still-tracked target (kind
    // "unknown"), not only on a genuine leak -- so it is the collection witness,
    // not the gate. The gate is size()===0 after settle: any target that
    // outlived its cycle is still counted. audit() runs the kernels for
    // structural orphans. Neither the cleanup nor the numeric tag closes over
    // the view.
    const warnings = [];
    const tracker = createLeakTracker({
        name: "lite-project-soak",
        onWarning: (w) => warnings.push(w.kind + ":" + w.reason),
    });

    for (let c = 0; c < CYCLES; c++) {
        const prng = makePrng((SEED ^ 0x7017) + c);
        const oracle = makeOracle();
        // A NODE-FREE source (plain Map): keyedStore would allocate an
        // undisposed signal per key, so the conservation baseline could never
        // return. The projection's own nodes are the only ones under test here.
        const backing = new Map();
        for (const k of KEYS) { const val = (frac(prng) * 100) | 0; backing.set(k, val); oracle.src.set(k, val); }
        const src = fromAccessors((k) => backing.get(k), (k, val) => backing.set(k, val));
        let v = project(src);
        // cheap corpus: a handful of set / commit / revert
        for (let i = 0; i < 6; i++) {
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            const r = frac(prng);
            if (r < 0.5) { const val = (frac(prng) * 100) | 0; v.set(k, val); oracle.ov.set(k, val); }
            else if (r < 0.7) { v.clear(k); oracle.ov.delete(k); }
            else if (r < 0.85) {
                v.commit(k);
                if (oracle.ov.has(k)) { oracle.src.set(k, oracle.ov.get(k)); oracle.ov.delete(k); }
            } else { v.revert(); oracle.ov.clear(); }
        }
        validate(v, null, oracle);
        // tag is a NUMBER, cleanup is a module fn -- neither closes over `v`.
        tracker.track(v, t7Cleanup, c);
        v.dispose();
        v = null;
    }

    globalThis.gc(); await settle(50);
    globalThis.gc(); await settle(50);

    const size = tracker.size();
    const audited = tracker.audit();
    check(size === 0, () => "T7 soak: tracker retained " + size + " views after " + CYCLES + " dispose cycles");
    check(audited.length === 0, () => "T7 soak: audit findings " + audited.length);
    check(warnings.length === 0, () => "T7 soak: warnings [" + warnings.join(",") + "]");
    metrics.leakSize = size;
    metrics.leakFindings = audited.length;
    metrics.leakWarnings = warnings.length;

    // -- prune-bound sub-soak (audit:true lives ONLY here) ------------------
    const pruneTracker = createLeakTracker({ name: "lite-project-prune" });
    const backing = new Map();
    let pv = project(fromAccessors((k) => backing.get(k), (k, val) => backing.set(k, val)));
    const pbase = graphSnapshot();
    for (let i = 0; i < 20000; i++) pv.get("uk" + i);   // 20000 distinct keys -> 20000 slots
    const grown = graphSnapshot().nodes - pbase.nodes;
    check(grown >= 20000, () => "T7 prune: expected >=20000 slot nodes, saw " + grown);
    const reclaimed = pv.prune();
    check(reclaimed >= 19990, () => "T7 prune: reclaimed only " + reclaimed + " of ~20000");
    check(graphSnapshot().nodes - pbase.nodes < 10,
        () => "T7 prune: activeNodes - base = " + (graphSnapshot().nodes - pbase.nodes) + " (>=10)");
    metrics.pruneReclaimed = reclaimed;

    // a pruned key rebuilds transparently on the next read
    backing.set("uk0", 12345);
    check(Object.is(pv.get("uk0"), 12345), () => "T7 prune: pruned key did not rebuild to the current source value");

    // audit:true handle: retains one owner-pool slot per handle -> only here.
    pruneTracker.track(pv, t7Cleanup, "prune", { audit: true });
    pv.dispose();
    pv = null;

    globalThis.gc(); await settle(50);
    globalThis.gc(); await settle(50);

    const psize = pruneTracker.size();
    check(psize === 0, () => "T7 prune: tracker retained " + psize + " after dispose");

    // -- TTL sub-soak: 1000 ttl overlays hold at most ONE handle -----------
    // Staggered deadlines exercise the re-arm path; the counting fake clock
    // proves maxOutstanding() === 1 at every instant, and outstanding() returns
    // to 0 after the drain fire and after dispose(). Own tracker + gc/settle pair.
    const ttlTracker = createLeakTracker({ name: "lite-project-ttl" });
    const clock = makeFakeClock();
    const ttlBacking = new Map();
    let tv = project(fromAccessors((k) => ttlBacking.get(k), (k, val) => ttlBacking.set(k, val)), clock);
    for (let i = 0; i < 1000; i++) {
        tv.set("t" + i, i, { ttl: 100 + i });
        check(clock.maxOutstanding() === 1, () => "T7 ttl: >1 handle after set " + i);
    }
    check(clock.outstanding() === 1, () => "T7 ttl: expected one armed handle before firing");
    clock.advance(100 + 1000);                       // past every deadline
    check(tv.overlaidCount() === 0, () => "T7 ttl: overlays survived their deadlines");
    check(tv.dirtyCount() === 0, () => "T7 ttl: dirtyCount not cleared by the fires");
    check(clock.outstanding() === 0, () => "T7 ttl: a handle survived the drain fire");
    check(clock.maxOutstanding() === 1, () => "T7 ttl: one-handle invariant broke during the soak");
    tv.set("last", 1, { ttl: 5 });                   // arm one more; dispose must cancel it
    check(clock.outstanding() === 1, () => "T7 ttl: re-arm after full drain failed");
    tv.dispose();
    check(clock.outstanding() === 0, () => "T7 ttl: dispose did not cancel the pending handle");
    ttlTracker.track(tv, t7Cleanup, "ttl");
    tv = null;

    globalThis.gc(); await settle(50);
    globalThis.gc(); await settle(50);
    const tsize = ttlTracker.size();
    const taudit = ttlTracker.audit();
    check(tsize === 0, () => "T7 ttl: tracker retained " + tsize + " after dispose");
    check(taudit.length === 0, () => "T7 ttl: audit findings " + taudit.length);

    // conservation: everything disposed, node census back at baseline.
    const dAfter = graphDelta(base);
    check(dAfter.nodes === 0, () => "T7 conservation: node census off baseline by " + dAfter.nodes);
    void cleanupCount;

    // -- projectCRDT build/dispose sub-soak ---------------------------------
    // The reconcile effect + per-overlaid-key tracked reads are the nodes under
    // test: a disposed handle must leave the census flat at cycle scale (t6's
    // Proof 6 is a warm-pass gate, not a per-call build/dispose witness). ONE
    // fake LWW-Map source is reused across every cycle; its lazily-created
    // per-key cells are NOT under test, so the census baseline is taken AFTER a
    // one-cycle warm-up that materialises them. Own tracker + gc/settle pair.
    // NUMBER tag, module cleanup -- neither closes over the handle.
    const crdtTracker = createLeakTracker({ name: "lite-project-crdt" });
    const fake = makeFakeMap({ signal });
    const CKEYS = ["cx", "cy", "cz"];

    // warm-up: build one handle to materialise the fake's persistent cells.
    let wv = projectCRDT(fake);
    wv.set(CKEYS[0], -1); fake.set(CKEYS[0], -1);   // echo -> reconcile drops the draft
    wv.set(CKEYS[1], -2);
    wv.set(CKEYS[2], -3);
    wv.commit();
    wv.dispose();
    wv = null;

    const cbase = graphSnapshot();
    for (let c = 0; c < CYCLES; c++) {
        const val = c + 1;                          // strictly monotone -> the echo always fires
        let cv = projectCRDT(fake);
        cv.set(CKEYS[0], val); fake.set(CKEYS[0], val);   // echo -> reconcile fires and drops it
        cv.set(CKEYS[1], val + 1);                  // staged
        cv.set(CKEYS[2], val + 2);                  // staged
        cv.commit();                                // promote the remaining drafts
        // tag is a NUMBER, cleanup is a module fn -- neither closes over `cv`.
        crdtTracker.track(cv, t7Cleanup, c);
        cv.dispose();
        cv = null;
    }

    globalThis.gc(); await settle(50);
    globalThis.gc(); await settle(50);

    const csize = crdtTracker.size();
    const caudit = crdtTracker.audit();
    check(csize === 0, () => "T7 crdt: tracker retained " + csize + " handles after " + CYCLES + " dispose cycles");
    check(caudit.length === 0, () => "T7 crdt: audit findings " + caudit.length);
    const cDelta = graphDelta(cbase);
    check(cDelta.nodes === 0, () => "T7 crdt: node census off baseline by " + cDelta.nodes);
}
