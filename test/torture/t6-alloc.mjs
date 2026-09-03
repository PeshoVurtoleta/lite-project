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

    v.dispose();
}
