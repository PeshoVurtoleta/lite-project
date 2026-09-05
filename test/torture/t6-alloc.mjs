/**
 * T6 -- the zero-alloc gate. On an ALREADY-TOUCHED key set, the get/set/clear
 * triangle allocates nothing the engine can avoid. Independent proofs:
 *   0. the TRANSIENT witness -- V8 new-space used-bytes delta over a GC-free
 *      50k-op window per warm surface (get/peek/set/toggle/triangle), <= 16384 B
 *      total each. The only lane that sees per-op garbage that never survives
 *      a collection (proofs 1-6 are all blind to it; a ~40 B/op context
 *      allocation passed them until 1.4.1).
 *   1. the heap gate (runOpsGate over the triangle) -- maxMajor 0, maxPauseMs 4,
 *      maxArrayBuffersGrowth 0 under stabilize:"deep";
 *   2. the structural gate the heap gate cannot make -- across 200k warmed
 *      toggles with one effect subscribed to dirtyCount(), the pool's
 *      poolGrowths AND totalAllocations deltas are both exactly 0.
 */
import { project, projectCRDT, keyedStore } from "../../Project.js";
import { effect, signal } from "@zakkster/lite-signal";
import { check, runOpsGate, runAllocsGate, allocTotal, graphSnapshot, graphDelta, metrics, recordGc, makeFakeMap } from "./harness.mjs";

const N = 256;
const MASK = N - 1;               // power-of-2 keyset, bitmask index
const HOT = 200000;

// Proof 5 fixtures, hoisted so the measured body allocates nothing itself: a
// no-op injected clock (never fires; the overlays are cleared/committed each
// iteration), one ttl opts bag, and two match-all predicates.
const NOOP_CLOCK = { now: () => 0, setTimer: () => 1, clearTimer: () => {} };
const TTL_OPTS = { ttl: 1000 };
const PRED_ALL = () => true;

export function run() {
    // Pre-touch a bounded key set so every slot (overlay signal + projected
    // computed) already exists -- the first touch of a brand-new key is the one
    // allocation the library never claims to avoid.
    const keys = new Array(N);
    const seed = {};
    for (let i = 0; i < N; i++) { keys[i] = "k" + i; seed[keys[i]] = i; }
    const src = keyedStore(seed);
    const v = project(src);
    for (let i = 0; i < N; i++) v.get(keys[i]);

    // -- Proof 0: the TRANSIENT witness (new-space delta) -------------------
    // The one lane Proofs 1-6 cannot cover: per-op garbage that never survives
    // a collection. Each warm per-op surface gets a GC-free 50k window; the
    // whole window may allocate at most TRANSIENT_BUDGET bytes TOTAL (fixed
    // measurement noise passes; any per-op cost fails). This is the gate that
    // catches a context allocation from a closure in a hot function's cold
    // branch -- 40 B/op sailed through Proofs 1-6 before 1.4.1.
    const TOPS = 50000;
    const TWARM = 5000;
    const TRANSIENT_BUDGET = 16384;
    const w = (name, total) => {
        check(total <= TRANSIENT_BUDGET,
            () => "T6 Proof 0 transient witness: warm " + name + " allocated " + total +
                " B over " + TOPS + " ops (" + (total / TOPS).toFixed(3) +
                " B/op, budget " + TRANSIENT_BUDGET + " B total)");
        return total;
    };
    w("get", allocTotal((i) => { v.get(keys[i & MASK]); }, TOPS, TWARM));
    w("peek", allocTotal((i) => { v.peek(keys[i & MASK]); }, TOPS, TWARM));
    w("set", allocTotal((i) => { v.set(keys[i & MASK], (i & 1) ? "x" : "y"); }, TOPS, TWARM));
    w("set/clear toggle", allocTotal((i) => {
        const k = keys[i & MASK];
        if (i & 1) v.clear(k); else v.set(k, i);
    }, TOPS, TWARM));
    const triangleTotal = w("get+set+clear triangle", allocTotal((i) => {
        const k = keys[i & MASK];
        v.get(k);
        v.set(k, i);
        v.clear(k);
    }, TOPS, TWARM));
    metrics.transientBytesPerOp = triangleTotal / TOPS;
    // Leave every key un-overlaid for the proofs below (the set window staged all N).
    v.revert();

    // -- Proof 1: the heap gate over the get/set/clear triangle -------------
    const gate = runOpsGate((i) => {
        const k = keys[i & MASK];
        v.get(k);
        v.set(k, i);
        v.clear(k);
    }, { ops: HOT, warmup: 20000 });
    check(gate.report.ok,
        () => "T6 triangle failed the zero-alloc gate: " +
            gate.report.verdict + " " + JSON.stringify(gate.report.violations));
    recordGc(gate.summary);
    // null = the profiler's per-op heap bracket was inconclusive; the GATE line
    // prints n/a rather than a fabricated 0.00 (the hard gate is checkNoGc).
    metrics.allocBytesPerOp = typeof gate.bytesPerOp === "number" ? gate.bytesPerOp : null;

    // -- Proof 2: pool census stays flat under warmed toggles + a dirtyCount
    // subscriber (bumping the dirty signal must mark subscribers, not allocate).
    let seen = 0;
    const stop = effect(() => { seen += v.dirtyCount(); });
    const before = graphSnapshot();
    for (let i = 0; i < HOT; i++) {
        const k = keys[i & MASK];
        v.set(k, i);
        v.clear(k);
    }
    const d = graphDelta(before);
    stop();
    check(d.growths === 0, () => "T6 poolGrowths moved by " + d.growths + " over warmed toggles");
    check(d.allocs === 0, () => "T6 totalAllocations moved by " + d.allocs + " over warmed toggles");
    metrics.poolGrowths = graphSnapshot().growths;
    void seen;

    // -- Proof 3: the retained-allocation gate over the SAME warmed triangle.
    // maxBytesPerCall:0 -- per-call bytes surviving a forced collection, min
    // across batches. This is the channel runOpsGate's async gc.major count
    // cannot see: arbitrary JS-object retention. An unsettled/inconclusive run
    // FAILS the gate (fail closed), never skips.
    const allocs = runAllocsGate((i) => {
        const k = keys[i & MASK];
        v.get(k);
        v.set(k, i);
        v.clear(k);
    }, { iterations: 50000, batches: 8 });
    check(allocs.ok,
        () => "T6 triangle failed the zero-retention gate: verdict=" + allocs.report.verdict +
            " settled=" + allocs.result.settled + " bytesPerCall=" + allocs.bytesPerCall +
            " " + JSON.stringify(allocs.report.violations));
    metrics.allocRetainedBytesPerCall =
        typeof allocs.bytesPerCall === "number" ? allocs.bytesPerCall : null;

    // -- Proof 4: the patch gate. forEachPatch over a warm overlaid set passes
    // both the heap gate and the zero-retention gate at the SAME strict rules.
    // The emit callback is hoisted OUTSIDE the measured body (a per-visit closure
    // would be the caller's allocation, not the library's -- that is T9's control).
    // Smaller loops than the triangle: the body visits every slot per call, so
    // the run stays fast. Proof 4 asserts only -- it does NOT overwrite
    // metrics.allocBytesPerOp / metrics.allocRetainedBytesPerCall (those carry
    // the triangle numbers the GATE line + CHANGELOG quote).
    const P = 32;
    for (let i = 0; i < P; i++) v.set(keys[i], -i - 1);   // bounded overlaid set
    let acc = 0;
    const emit = (k, f, t) => { acc += 1; };
    const patchGate = runOpsGate((i) => v.forEachPatch(emit), { ops: 20000, warmup: 4000 });
    check(patchGate.report.ok,
        () => "T6 forEachPatch failed the zero-alloc gate: " +
            patchGate.report.verdict + " " + JSON.stringify(patchGate.report.violations));
    recordGc(patchGate.summary);
    const patchAllocs = runAllocsGate((i) => v.forEachPatch(emit), { iterations: 4000, batches: 8 });
    check(patchAllocs.ok,
        () => "T6 forEachPatch failed the zero-retention gate: verdict=" + patchAllocs.report.verdict +
            " settled=" + patchAllocs.result.settled + " bytesPerCall=" + patchAllocs.bytesPerCall +
            " " + JSON.stringify(patchAllocs.report.violations));
    void acc;

    // -- Proof 5: warm ttl re-set + commitWhere + clearWhere retain 0 B/call.
    // Its OWN handle under the injected NO-OP clock (T8: the Proof 1-4 view is
    // bound to the default clock and still holds 32 overlays from Proof 4). The
    // clock never fires, so each iteration fully specifies + drops its overlay:
    // set(k, i, {ttl}) arms, then commitWhere/clearWhere drops it (cancelling the
    // expiry). check() ONLY -- it must NOT overwrite metrics.allocBytesPerOp /
    // metrics.allocRetainedBytesPerCall (those carry the triangle numbers the
    // GATE line + CHANGELOG quote).
    const v5 = project(src, NOOP_CLOCK);
    for (let i = 0; i < N; i++) v5.get(keys[i]);          // warm every slot
    const ttlAllocs = runAllocsGate((i) => {
        const k = keys[i & MASK];
        v5.set(k, i, TTL_OPTS);
        if (i & 1) v5.commitWhere(PRED_ALL); else v5.clearWhere(PRED_ALL);
    }, { iterations: 20000, batches: 8 });
    check(ttlAllocs.ok,
        () => "T6 Proof 5 (ttl re-set + where-ops) failed the zero-retention gate: verdict=" +
            ttlAllocs.report.verdict + " settled=" + ttlAllocs.result.settled +
            " bytesPerCall=" + ttlAllocs.bytesPerCall + " " + JSON.stringify(ttlAllocs.report.violations));
    v5.dispose();

    // -- Proof 6: projectCRDT warm echo-drop reconcile pass. Each iteration stages
    // a scalar draft then writes the authoritative echo, so the reconcile effect's
    // steady-state body (dirtyCount + forEachOverlay + reconcileAll drop) fires and
    // drops -- and retains 0 B/call. check() ONLY: it must NOT overwrite
    // metrics.allocBytesPerOp / metrics.allocRetainedBytesPerCall (those carry the
    // triangle numbers the GATE line + CHANGELOG quote).
    const cmap = makeFakeMap({ signal });
    for (let i = 0; i < N; i++) cmap.set(keys[i], i);
    const cv = projectCRDT(cmap);
    for (let i = 0; i < N; i++) cv.get(keys[i]);          // warm every slot
    const echoAllocs = runAllocsGate((i) => {
        const k = keys[i & MASK];
        cv.set(k, i);                                     // stage (effect fires; conflict, kept)
        cmap.set(k, i);                                   // authoritative echo (effect fires; drops)
    }, { iterations: 20000, batches: 8 });
    check(echoAllocs.ok,
        () => "T6 projectCRDT warm echo-drop reconcile pass failed the zero-retention gate: verdict=" +
            echoAllocs.report.verdict + " settled=" + echoAllocs.result.settled +
            " bytesPerCall=" + echoAllocs.bytesPerCall + " " + JSON.stringify(echoAllocs.report.violations));
    cv.dispose();

    v.dispose();
}
