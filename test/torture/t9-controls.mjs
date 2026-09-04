/**
 * T9 -- controls. Every gate the suite leans on, deliberately broken IN-PROCESS,
 * must be caught. A control that does NOT trip die()s the run: a gate that cannot
 * fail is decoration. Each control reuses the SAME RULES / runOpsGate / validate /
 * oracle as the gate it proves, so a control can never drift from its gate.
 */
import { createRegistry, CapacityError, effect } from "@zakkster/lite-signal";
import { project, createProjector, fromAccessors, keyedStore } from "../../Project.js";
import { die, check, runOpsGate, runAllocsGate, makeOracle, validate, graphSnapshot } from "./harness.mjs";

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
}
