/**
 * test/torture/harness.mjs -- the shared spine for the lite-project torture gate.
 *
 * Provides: a seeded PRNG (replayable via TORTURE_SEED), a zero-alloc assert
 * (message built by a thunk, only on failure), the gc-profiler gate wrapper, a
 * signal-graph snapshot/delta, a plain-Map overlay oracle, and validate() -- the
 * public-surface invariant checked between phases.
 *
 * The lite-signal registry is pre-grown EAGERLY to a fixed capacity with
 * onCapacityExceeded:"throw": a registry that grows mid-measurement is the exact
 * allocation the gate exists to catch, and under "lazy" prealloc the pool is a
 * ledger whose real node construction would happen inside the measured window.
 * "eager" builds every node up front; "throw" turns any overflow into a loud
 * CapacityError instead of a silent pool growth.
 *
 * -- THE LEAK CHANNELS (honest) --
 * runOpsGate's gc.major channel is BEST-EFFORT: Node delivers 'gc'
 * PerformanceObserver entries asynchronously, but measureOps reads its summary
 * synchronously, so the gc count can read 0 on an undelivered window -- a
 * retained plain-object loop can slip past maxMajor alone. The BINDING leak
 * channels are therefore three, not one:
 *   1. maxArrayBuffersGrowth (runOpsGate) -- catches ArrayBuffer-backed growth;
 *   2. runAllocsGate (measureAllocs, maxBytesPerCall:0) -- the profiler-native
 *      zero-RETENTION assertion: per-call bytes surviving a forced collection,
 *      taken as the MIN across batches so ambient noise (which only ever adds)
 *      is stripped -- catches arbitrary JS-object retention;
 *   3. the structural pool census (T6: poolGrowths + totalAllocations deltas) --
 *      exact, but scoped to lite-signal pool nodes only.
 * An untrustworthy retained figure (source could not settle every batch) routes
 * to inconclusive, which this harness treats as a FAIL -- never a skip.
 */
import { setDefaultRegistry, createRegistry, stats } from "@zakkster/lite-signal";
import { measureOps, checkNoGc, measureAllocs, checkAllocs } from "@zakkster/lite-gc-profiler";

/* -- Seeded xorshift32 (must not be seeded with 0) -------------------------- */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n;
})();

export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Float in [0,1) from a makePrng() instance. */
export function frac(next) { return next() / 4294967296; }

/* -- Zero-alloc assert: build the message only when it fails ----------------- */
export function die(msg) {
    process.stderr.write(
        "torture: FAIL -- " + msg +
        "\n  replay: TORTURE_SEED=" + SEED + " node --expose-gc test/torture.mjs\n");
    process.exit(1);
}
export function check(cond, msgThunk) { if (!cond) die(msgThunk()); }

/* -- The signal registry the whole suite runs under ------------------------- */
export function installRegistry(maxNodes = 1 << 18, maxLinks = 1 << 20) {
    setDefaultRegistry(createRegistry({
        maxNodes,
        maxLinks,
        prealloc: "eager",
        onCapacityExceeded: "throw",
    }));
}

/* -- The zero-alloc gate ---------------------------------------------------- */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Measure `fn` (a zero-alloc `(i) => {}` body) over one settled window and gate
 * it against RULES. Returns { report, summary, bytesPerOp }. lite-gc-profiler
 * exports measureOps + checkNoGc, never a runOpsGate -- this wrapper is local so
 * every gate and its T9 control share one code path. `stabilize:"deep"` is
 * mandatory: ArrayBuffer backing stores live outside the V8 heap, so without a
 * deep stabilize maxArrayBuffersGrowth goes inconclusive. checkNoGc REQUIRES the
 * rules argument -- omitting it yields a no_rules/inconclusive verdict.
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? Math.min(2000, opts.ops >> 3) : opts.warmup,
        stabilize: "deep",
    });
    return {
        report: checkNoGc(res.summary, RULES),
        summary: res.summary,
        bytesPerOp: res.bytesPerOp,
    };
}

/* -- The zero-RETENTION gate (profiler-native) ------------------------------ */
/**
 * The zero-retention rule shared by the T6 alloc gate and its T9 control, so the
 * control can never drift from the gate it proves. maxBytesPerCall:0 is the
 * profiler's documented zero-retention assertion.
 */
export const ALLOC_RULES = { maxBytesPerCall: 0 };

/**
 * Measure per-call RETAINED allocation (bytes surviving a forced collection,
 * min-over-batches) and gate it against ALLOC_RULES. Requires --expose-gc.
 * Returns { report, result, bytesPerCall, ok }. An inconclusive verdict OR an
 * unsettled batch set is a FAIL, never a skip: `ok` is true only on a settled
 * "pass".
 */
export function runAllocsGate(fn, opts) {
    const iterations = opts.iterations;
    const result = measureAllocs(fn, {
        iterations,
        batches: opts.batches === undefined ? 8 : opts.batches,
        warmup: opts.warmup === undefined ? iterations : opts.warmup,
    });
    const report = checkAllocs(result, ALLOC_RULES);
    const ok = report.verdict === "pass" && result.settled === true;
    return { report, result, bytesPerCall: result.bytesPerCall, ok };
}

/* -- Signal-graph snapshot / delta ------------------------------------------ */
/**
 * Read the pool census. stats() is PER-REGISTRY: the top-level stats() reports
 * the default registry only, so a tier bound via createProjector(reg) passes its
 * own `reg` to snapshot the graph it actually mutates.
 * @param {object} [reg] optional registry (reg.stats()); default registry if omitted.
 */
export function graphSnapshot(reg) {
    const s = reg && typeof reg.stats === "function" ? reg.stats() : stats();
    return {
        nodes: s.activeNodes,
        links: s.activeLinks,
        growths: s.poolGrowths,
        allocs: s.totalAllocations,
        disposals: s.totalDisposals,
    };
}

export function graphDelta(before, reg) {
    const now = graphSnapshot(reg);
    return {
        nodes: now.nodes - before.nodes,
        links: now.links - before.links,
        growths: now.growths - before.growths,
        allocs: now.allocs - before.allocs,
        disposals: now.disposals - before.disposals,
    };
}

/* -- Plain-Map overlay oracle ----------------------------------------------- */
/**
 * A dependency-free model of a projection: `src` is the authoritative backing,
 * `ov` the staged overlays. No reactive nodes -- it exists purely to be the
 * ground truth validate() compares the live view against.
 */
export function makeOracle() {
    const src = new Map();
    const ov = new Map();
    return {
        src,
        ov,
        effective: (k) => (ov.has(k) ? ov.get(k) : src.get(k)),
        dirty: () => ov.size,
    };
}

/* -- validate(view, source, oracle): the public-surface invariant ----------- */
/**
 * Off the public projection surface, O(slots), called BETWEEN phases only:
 *   - dirtyCount() === overlaidCount() === oracle.ov.size;
 *   - every overlaid key: peek(k) === get(k) === ov.get(k), regardless of source
 *     (masking holds under source noise);
 *   - every clean key: get(k) === the current source value;
 *   - the caller-supplied `source` snapshot Map is byte-identical to the oracle's
 *     src unless the phase just committed (then the caller passes null to skip).
 *
 * @param {object} view   a project() handle.
 * @param {Map|null} source snapshot of the backing before the phase, or null to skip.
 * @param {object} oracle a makeOracle() model.
 */
export function validate(view, source, oracle) {
    const dc = view.dirtyCount();
    const oc = view.overlaidCount();
    check(dc === oc, () => "validate: dirtyCount " + dc + " != overlaidCount " + oc);
    check(dc === oracle.ov.size,
        () => "validate: dirtyCount " + dc + " != oracle.ov.size " + oracle.ov.size);

    for (const [k, v] of oracle.ov) {
        const pk = view.peek(k);
        check(Object.is(pk, v),
            () => "validate: peek(" + String(k) + ") masking broke: " + String(pk) + " != " + String(v));
        const gk = view.get(k);
        check(Object.is(gk, v),
            () => "validate: get(" + String(k) + ") masking broke: " + String(gk) + " != " + String(v));
    }

    for (const [k, v] of oracle.src) {
        if (oracle.ov.has(k)) continue;
        const gk = view.get(k);
        check(Object.is(gk, v),
            () => "validate: clean get(" + String(k) + ") " + String(gk) + " != source " + String(v));
    }

    if (source !== null) {
        check(source.size === oracle.src.size,
            () => "validate: source snapshot size " + source.size + " != oracle.src " + oracle.src.size);
        for (const [k, v] of oracle.src) {
            check(source.has(k) && Object.is(source.get(k), v),
                () => "validate: source mutated at " + String(k) + " (non-commit phase touched the backing)");
        }
    }
    return true;
}

/* -- Metrics: tiers write, the entry prints the GATE line ------------------- */
export const metrics = {
    leakSize: 0,
    leakFindings: 0,
    leakWarnings: 0,
    gcMajor: 0,
    gcMinor: 0,
    gcMaxMs: 0,
    allocBytesPerOp: null,
    allocRetainedBytesPerCall: null,
    poolGrowths: 0,
    pruneReclaimed: 0,
};

/** Fold one gc summary into the reported worst-case metrics. */
export function recordGc(summary) {
    if (summary.gc.major > metrics.gcMajor) metrics.gcMajor = summary.gc.major;
    if (summary.gc.minor > metrics.gcMinor) metrics.gcMinor = summary.gc.minor;
    if (summary.gc.maxMs > metrics.gcMaxMs) metrics.gcMaxMs = summary.gc.maxMs;
}
