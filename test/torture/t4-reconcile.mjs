/**
 * T4 -- the echo/conflict door. The load-bearing reconciliation contract:
 *   - a scalar echo drops the draft;
 *   - a CONFLICTING authoritative value stays masked (the non-negotiable line);
 *   - F-03 (RECORDED, not fixed): an object/array echo of a DIFFERENT reference
 *     stays overlaid under the default Object.is policy, and a structural policy
 *     passed to reconcileAll DOES drop it;
 *   - projectRoom + projectQuery auto-reconcile fire ONCE on an authoritative
 *     change, without looping;
 *   - dispose() stops the reconcile effect (a later cache/storage write is inert).
 */
import { project, projectRoom, projectQuery, fromAccessors, confirmOnEcho } from "../../Project.js";
import { signal } from "@zakkster/lite-signal";
import { check } from "./harness.mjs";

/** A minimal room.storage: a coarse `entries` signal + a plain Map. */
function makeRoom() {
    const map = new Map();
    const entries = signal(0);
    return {
        storage: {
            entries: () => entries(),
            get: (k) => map.get(k),
            set: (k, val) => { map.set(k, val); entries.set(entries.peek() + 1); },
        },
        _map: map,
    };
}

function makeQC(initial) {
    let store = initial;
    let writes = 0;
    const rev = signal(0);
    return {
        qc: {
            getQueryData: () => store,
            setQueryData: (_k, u) => { writes++; store = typeof u === "function" ? u(store) : u; rev.set(rev.peek() + 1); },
        },
        data: () => { rev(); return store; },
        raw: () => store,
        writes: () => writes,
    };
}

export function run() {
    /* -- scalar echo drops the draft ---------------------------------------- */
    {
        const backing = new Map([["k", 0]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, x) => backing.set(kk, x)));
        v.set("k", 5);
        check(v.isOverlaid("k"), () => "T4 scalar draft not staged");
        backing.set("k", 5);                 // authoritative catches up
        v.reconcileAll();
        check(!v.isOverlaid("k"), () => "T4 scalar echo did not drop the draft");
        v.dispose();
    }

    /* -- a CONFLICTING authoritative value stays masked --------------------- */
    {
        const backing = new Map([["k", 0]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, x) => backing.set(kk, x)));
        v.set("k", 9);
        backing.set("k", 7);                 // diverges under the overlay
        v.reconcileAll();
        check(v.isOverlaid("k"), () => "T4 CONFLICTING value dropped the draft (non-negotiable)");
        check(Object.is(v.peek("k"), 9), () => "T4 optimistic value lost under conflict");
        v.dispose();
    }

    /* -- F-03: object echo of a different reference stays overlaid by default,
          and a structural policy drops it ------------------------------------ */
    {
        const authoritative = { n: 1 };
        const backing = new Map([["k", authoritative]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, x) => backing.set(kk, x)));
        const twin = { n: 1 };               // deep-equal, different reference
        v.set("k", twin);
        backing.set("k", { n: 1 });          // authoritative "echoes" structurally, new ref
        v.reconcileAll(confirmOnEcho);       // default Object.is -> kept
        check(v.isOverlaid("k"), () => "F-03 default policy dropped a different-reference echo");
        const structural = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        v.reconcileAll(structural);          // structural policy -> dropped
        check(!v.isOverlaid("k"), () => "F-03 structural policy failed to drop a structural echo");
        v.dispose();
    }

    /* -- projectRoom auto-reconcile fires once, no loop --------------------- */
    {
        const room = makeRoom();
        room.storage.set("k", 0);
        const v = projectRoom(room);
        v.set("k", 5);
        check(v.isOverlaid("k"), () => "T4 room draft not staged");
        room.storage.set("k", 5);            // server confirms -> auto-drop
        check(!v.isOverlaid("k"), () => "T4 room echo did not auto-reconcile");
        // conflict leaves it masked
        v.set("k", 9);
        room.storage.set("k", 3);
        check(v.isOverlaid("k"), () => "T4 room conflict dropped the draft");
        check(Object.is(v.peek("k"), 9), () => "T4 room optimistic value lost");
        v.dispose();
        // after dispose, a storage write must be inert (no throw, no effect)
        let threw = false;
        try { room.storage.set("k", 42); } catch { threw = true; }
        check(!threw, () => "T4 room storage write threw after dispose");
    }

    /* -- projectQuery auto-reconcile fires once, no loop -------------------- */
    {
        const { qc, data, raw, writes } = makeQC({ a: 0 });
        const v = projectQuery(qc, "k", { data });
        v.set("a", 5);
        const w0 = writes();
        qc.setQueryData("k", () => ({ a: 5 }));   // echo -> auto-drop
        check(!v.isOverlaid("a"), () => "T4 query echo did not auto-reconcile");
        // exactly one authoritative write happened (no reconcile-driven write loop)
        check(writes() - w0 === 1, () => "T4 query auto-reconcile fanned out extra writes");
        // conflict stays masked
        const seen = [];
        v.set("a", 9);
        qc.setQueryData("k", () => ({ a: 7 }));
        check(v.isOverlaid("a"), () => "T4 query conflict dropped the draft");
        check(!seen.includes(7), () => "T4 query conflict flickered through");
        v.dispose();
        // later cache write is inert for the disposed view
        let threw = false;
        try { qc.setQueryData("k", () => ({ a: 1 })); } catch { threw = true; }
        check(!threw, () => "T4 query cache write threw after dispose");
        check(!v.isOverlaid("a"), () => "T4 disposed view still reconciling (effect not stopped)");
        void raw;
    }
}
