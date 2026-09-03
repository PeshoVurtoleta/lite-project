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
import { project, fromAccessors } from "../../Project.js";
import { SEED, makePrng, frac, check, makeOracle, validate, graphSnapshot, graphDelta, metrics } from "./harness.mjs";

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

    // conservation: everything disposed, node census back at baseline.
    const dAfter = graphDelta(base);
    check(dAfter.nodes === 0, () => "T7 conservation: node census off baseline by " + dAfter.nodes);
    void cleanupCount;
}
