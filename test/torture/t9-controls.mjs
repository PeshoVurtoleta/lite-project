/**
 * T9 -- controls. Every gate the suite leans on, deliberately broken IN-PROCESS,
 * must be caught. A control that does NOT trip die()s the run: a gate that cannot
 * fail is decoration. Each control reuses the SAME RULES / runOpsGate / validate /
 * oracle as the gate it proves, so a control can never drift from its gate.
 */
import { createRegistry, CapacityError, effect, signal } from "@zakkster/lite-signal";
import { project, createProjector, fromAccessors, keyedStore } from "../../Project.js";
import { die, check, runOpsGate, runAllocsGate, makeOracle, validate, graphSnapshot, makeFakeClock, makeFakeMap } from "./harness.mjs";

/**
 * Run `fn` expecting it to reach die() (which calls process.exit after writing to
 * stderr). Swaps process.exit -> throw and swallows the control's expected FAIL
 * line, restoring both in finally. If fn did NOT trip, die() the real run.
 */
function expectDie(fn, controlName) {
    const realExit = process.exit;
    const realWrite = process.stderr.write;
    let tripped = false;
    process.exit = () => { tripped = true; throw new Error("__control_die__"); };
    process.stderr.write = () => true;
    try {
        fn();
    } catch (e) {
        if (!(e && e.message === "__control_die__")) {
            process.exit = realExit; process.stderr.write = realWrite;
            throw e;
        }
    } finally {
        process.exit = realExit;
        process.stderr.write = realWrite;
    }
    if (!tripped) die(controlName + ": gate did not trip (vacuous)");
}

export function run() {
    // (a) the zero-alloc gate must REJECT a retained-allocation hot loop.
    const sink = [];
    const g = runOpsGate(() => { sink.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
    if (g.report.ok) die("T9 (a): an allocating hot loop passed the zero-alloc gate");
    sink.length = 0;

    // (b) an UNDERSIZED "grow" registry must be observed to grow its pool, and
    // its "throw" twin must raise CapacityError. Size 64 on purpose -- a
    // right-sized "grow" registry would be vacuously flat.
    {
        const growReg = createRegistry({ maxNodes: 64, maxLinks: 128, prealloc: "eager", onCapacityExceeded: "grow" });
        const { project: growProject } = createProjector(growReg);
        const gv = growProject(fromAccessors((k) => k, () => {}));
        for (let i = 0; i < 200; i++) gv.get("gk" + i);   // 200 distinct keys -> pool overflow
        check(graphSnapshot(growReg).growths > 0,
            () => "T9 (b): undersized grow registry never grew its pool");
        gv.dispose();

        const throwReg = createRegistry({ maxNodes: 64, maxLinks: 128, prealloc: "eager", onCapacityExceeded: "throw" });
        const { project: throwProject } = createProjector(throwReg);
        const tv = throwProject(fromAccessors((k) => k, () => {}));
        let caught = false;
        try { for (let i = 0; i < 200; i++) tv.get("tk" + i); }
        catch (e) { caught = e instanceof CapacityError; }
        check(caught, () => "T9 (b): undersized throw registry did not raise CapacityError");
        // no default-registry swap happened, so nothing to restore.
    }

    // (c) a policy ()=>true drops a CONFLICTING draft -- the T4 masked-conflict
    // assertion shape must then report failure (non-vacuity).
    {
        const backing = new Map([["k", 0]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, x) => backing.set(kk, x)));
        v.set("k", 9);
        backing.set("k", 7);                        // conflict: 7 != 9
        v.reconcileAll(() => true);                 // bad policy: drops it anyway
        expectDie(
            () => check(v.isOverlaid("k"), () => "conflict draft was dropped"),
            "T9 (c)");                              // the T4 assertion shape fails
        v.dispose();
    }

    // (d) a forced dispose of an observed slot's computed must make validate()
    // fail: after dispose the staged overlay is gone, so the oracle (still
    // expecting it) no longer matches the view.
    {
        const src = keyedStore({ k: 0 });
        const v = project(src);
        const oracle = makeOracle();
        oracle.src.set("k", 0);
        const stop = effect(() => { v.get("k"); });   // observe the slot's computed
        v.set("k", 5); oracle.ov.set("k", 5);
        validate(v, null, oracle);                    // consistent before the break
        v.dispose();                                  // force-dispose the observed computed
        expectDie(() => validate(v, null, oracle), "T9 (d)");
        stop();
    }

    // (e) an oracle desync of +1 must fail the dirtyCount === oracle compare.
    {
        const src = keyedStore({ k: 0 });
        const v = project(src);
        const oracle = makeOracle();
        oracle.src.set("k", 0);
        v.set("k", 5); oracle.ov.set("k", 5);
        validate(v, null, oracle);                    // consistent
        oracle.ov.set("phantom", 1);                  // desync +1
        expectDie(() => validate(v, null, oracle), "T9 (e)");
        v.dispose();
    }

    // (f) the retained-allocation gate must REJECT a loop that retains plain
    // objects -- the exact channel runOpsGate's async gc.major count misses.
    // sink is held alive PAST the check so the bytes genuinely survive the
    // forced collections, then released.
    {
        const sink = [];
        const fg = runAllocsGate((i) => { sink.push({ n: i }); }, { iterations: 50000, batches: 8 });
        if (fg.ok) die("T9 (f): a plain-object retention loop passed the zero-retention gate (bytesPerCall=" + fg.bytesPerCall + ")");
        sink.length = 0;
    }

    // (g) the retained-allocation gate must REJECT a forEachPatch emitter that
    // builds a {key,from,to} record per visit into a retained sink -- the exact
    // allocation Proof 4's hoisted emit avoids. Same runAllocsGate / ALLOC_RULES
    // as the real gate, so the control can never drift from what it proves.
    {
        const src = keyedStore({});
        const v = project(src);
        for (let i = 0; i < 32; i++) v.set("g" + i, i);
        const sink = [];
        const gg = runAllocsGate(
            (i) => v.forEachPatch((k, f, t) => sink.push({ key: k, from: f, to: t })),
            { iterations: 4000, batches: 8 });
        if (gg.ok) die("T9 (g): a per-visit-allocating forEachPatch emitter passed the zero-retention gate (bytesPerCall=" + gg.bytesPerCall + ")");
        sink.length = 0;
        v.dispose();
    }

    // (h) the T4 deterministic TTL expiry assertion, re-run against a DEFAULT
    // (real) clock, must trip: with no injected advance nothing has fired, so the
    // overlay is still staged and the "expired" assertion fails. Proves the
    // injected clock has teeth. Dispose after, so no real setTimeout handle lives.
    {
        const src = keyedStore({ k: 0 });
        const v = project(src);                     // default real clock -- cannot advance
        v.set("k", 5, { ttl: 1 });
        expectDie(
            () => check(!v.isOverlaid("k"), () => "ttl overlay did not expire"),
            "T9 (h)");
        v.dispose();                                // cancel the real handle
    }

    // (i) a per-key-timer variant (a clock whose clearTimer is a no-op, so every
    // re-arm LEAKS a handle) driven through the same makeFakeClock counters must
    // trip the same maxOutstanding() <= 1 bound the T7 gate asserts. Decreasing
    // deadlines force a re-arm on every set.
    {
        const base = makeFakeClock();
        const leakyClock = { now: base.now, setTimer: base.setTimer, clearTimer: () => {} };
        const src = keyedStore({});
        const v = project(src, leakyClock);
        for (let i = 0; i < 5; i++) v.set("k" + i, i, { ttl: 100 - i * 10 });
        expectDie(
            () => check(base.maxOutstanding() <= 1, () => "outstanding handles exceeded 1"),
            "T9 (i)");
        v.dispose();
    }

    // (j) a COARSE-read reconcile effect (reads every cell in the map instead of
    // only the overlaid keys) must FAIL the granularity run-count law the fine
    // projectCRDT effect satisfies: an authoritative write to a NON-overlaid key
    // fires the coarse pass, so the policy counter moves where the gate demands 0.
    // Same makeFakeMap / policy-counter shape as t5's crdtGranularity gate.
    {
        const map = makeFakeMap({ signal });
        const allKeys = ["a"];
        for (let i = 0; i < 10; i++) { const n = "n" + i; map.set(n, 0); allKeys.push(n); }
        map.set("a", 0);
        let policyCalls = 0;
        const policy = (auth, ov) => { policyCalls++; return Object.is(auth, ov); };
        const source = { get: (k) => map.get(k), set: (k, val) => map.set(k, val) };
        const v = project(source);
        // The BROKEN effect: reads EVERY cell (whole-map coarse), not only overlays.
        const stop = effect(() => {
            v.dirtyCount();
            for (const k of allKeys) map.get(k);        // COARSE: tracks every cell
            v.reconcileAll(policy);
        });
        v.set("a", 9); map.set("a", 7);                 // a overlaid, conflict kept
        const base = policyCalls;
        for (let i = 0; i < 10; i++) map.set("n" + i, i + 1);   // NON-overlaid writes
        expectDie(
            () => check(policyCalls - base === 0,
                () => "reconcile fired on non-overlaid writes (" + (policyCalls - base) + ")"),
            "T9 (j)");
        stop(); v.dispose();
    }

    // (k) a PEEK-ONLY stale-deps effect (drops the view.dirtyCount() tracked read)
    // must MISS a late-overlay echo: a key overlaid AFTER the effect's last run has
    // its source cell untracked, so the echo never fires the reconcile and the
    // draft sticks -- isOverlaid stays true where the fine effect drops it.
    {
        const map = makeFakeMap({ signal });
        map.set("k", 0);
        const source = { get: (kk) => map.get(kk), set: (kk, vv) => map.set(kk, vv) };
        const v = project(source);
        const _trackSrc = (kk) => { map.get(kk); };
        const stop = effect(() => {
            // NO view.dirtyCount() -- the stale-deps trap. At first run nothing is
            // overlaid, so forEachOverlay tracks no cell and the effect never re-runs.
            v.forEachOverlay(_trackSrc);
            v.reconcileAll();
        });
        v.set("k", 5);                                   // overlaid AFTER the last (empty) run
        map.set("k", 5);                                 // echo -- a correct effect drops it
        expectDie(
            () => check(!v.isOverlaid("k"), () => "late-overlay echo was not dropped"),
            "T9 (k)");
        stop(); v.dispose();
    }
}
