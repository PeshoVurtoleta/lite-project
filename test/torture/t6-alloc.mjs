/**
 * T6 -- the zero-alloc gate. On an ALREADY-TOUCHED key set, the get/set/clear
 * triangle allocates nothing the engine can avoid. Two independent proofs:
 *   1. the heap gate (runOpsGate over the triangle) -- maxMajor 0, maxPauseMs 4,
 *      maxArrayBuffersGrowth 0 under stabilize:"deep";
 *   2. the structural gate the heap gate cannot make -- across 200k warmed
 *      toggles with one effect subscribed to dirtyCount(), the pool's
 *      poolGrowths AND totalAllocations deltas are both exactly 0.
 */
import { project, keyedStore } from "../../Project.js";
import { effect } from "@zakkster/lite-signal";
import { check, runOpsGate, runAllocsGate, graphSnapshot, graphDelta, metrics, recordGc } from "./harness.mjs";

const N = 256;
const MASK = N - 1;               // power-of-2 keyset, bitmask index
const HOT = 200000;

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

    v.dispose();
}
