/**
 * T1 -- degenerate inputs. One case per class of hostile key, hostile value, and
 * hostile source, plus the shipped 1.1.0 projectQuery merge pins (own-keys-only,
 * symbol-keyed draft survival, "__proto__" lands as an own field and injects
 * nothing). Correctness door, not a hot path -- run between phases.
 */
import { project, projectQuery, fromAccessors } from "../../Project.js";
import { signal } from "@zakkster/lite-signal";
import { check } from "./harness.mjs";

/** A structural query-client fake (the surface projectQuery documents). */
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
    /* -- hostile keys -------------------------------------------------------- */
    const SYM = Symbol("degenerate");
    const LONG = "x".repeat(4096);
    const keys = ["__proto__", SYM, 42, LONG];
    for (const k of keys) {
        const backing = new Map([[k, "base"]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, val) => backing.set(kk, val)));
        check(Object.is(v.get(k), "base"), () => "T1 key " + String(k) + " base read");
        v.set(k, "staged");
        check(Object.is(v.get(k), "staged"), () => "T1 key " + String(k) + " overlay read");
        check(v.isOverlaid(k), () => "T1 key " + String(k) + " not overlaid");
        check(v.dirtyCount() === 1, () => "T1 key " + String(k) + " dirtyCount");
        v.commit();
        check(Object.is(backing.get(k), "staged"), () => "T1 key " + String(k) + " commit did not land");
        check(v.dirtyCount() === 0, () => "T1 key " + String(k) + " dirty after commit");
        v.dispose();
    }

    /* -- hostile values ------------------------------------------------------ */
    const twinA = { n: 1, deep: [1, 2] };
    const twinB = { n: 1, deep: [1, 2] };            // structural twin, different ref
    const protoBearing = JSON.parse('{"ok":1,"__proto__":{"pwned":1}}');
    const vals = [undefined, NaN, -0, null, protoBearing, twinB];
    for (let i = 0; i < vals.length; i++) {
        const val = vals[i];
        const backing = new Map([["k", twinA]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, x) => backing.set(kk, x)));
        v.set("k", val);
        check(Object.is(v.get("k"), val), () => "T1 value #" + i + " overlay read");
        check(Object.is(v.peek("k"), val), () => "T1 value #" + i + " peek");
        v.commit();
        check(Object.is(backing.get("k"), val), () => "T1 value #" + i + " commit");
        v.dispose();
    }
    check({}.pwned === undefined, () => "T1 Object.prototype polluted by a proto-bearing value");

    /* -- structural twin is NOT dropped by the default echo policy ------------ */
    {
        const backing = new Map([["k", twinA]]);
        const v = project(fromAccessors((kk) => backing.get(kk), (kk, x) => backing.set(kk, x)));
        v.set("k", twinB);                            // deep-equal but a different reference
        backing.set("k", twinB);                      // authoritative "echoes" the same ref? no -- set twinA back
        backing.set("k", twinA);
        v.reconcileAll();                             // default Object.is: twinA !== twinB -> kept
        check(v.isOverlaid("k"), () => "T1 structural twin dropped under default Object.is policy");
        v.dispose();
    }

    /* -- hostile sources ----------------------------------------------------- */
    // A source whose get() throws: fail loud, overlay bag stays intact.
    {
        let boom = false;
        const backing = new Map([["a", 1]]);
        const v = project(fromAccessors(
            (kk) => { if (boom && kk === "a") throw new Error("source exploded"); return backing.get(kk); },
            (kk, x) => backing.set(kk, x),
        ));
        v.set("a", 5);
        boom = true;
        // get() tracks BOTH overlay and source, so a throwing source.get()
        // escapes loudly -- the projection never swallows it. What must hold is
        // that the overlay bag is untouched: peek() (overlay-only, no source
        // read) still returns the staged value and the dirty accounting is sound.
        try { v.get("a"); } catch { /* fail loud is correct */ }
        check(v.dirtyCount() === v.overlaidCount(), () => "T1 dirty desync after throwing source");
        check(Object.is(v.peek("a"), 5), () => "T1 throwing source lost the staged value");
        boom = false;
        v.dispose();
    }
    // A source that returns undefined for everything.
    {
        const v = project(fromAccessors(() => undefined, () => {}));
        check(v.get("missing") === undefined, () => "T1 undefined source get");
        check(!v.isOverlaid("missing"), () => "T1 undefined source falsely overlaid");
        v.set("missing", 7);
        check(Object.is(v.get("missing"), 7), () => "T1 overlay over undefined source");
        v.clear("missing");
        check(v.get("missing") === undefined, () => "T1 clear back to undefined source");
        v.dispose();
    }

    /* -- projectQuery merge pins (shipped 1.1.0 semantics) ------------------- */
    // "__proto__" draft lands as a real own field, injects nothing.
    {
        const { qc, data, raw } = makeQC({ name: "ada" });
        const v = projectQuery(qc, "k", { data });
        v.set("__proto__", { pwned: 1 });
        v.commit();
        const rec = raw();
        check(Object.prototype.hasOwnProperty.call(rec, "__proto__"),
            () => "T1 projectQuery '__proto__' draft dropped");
        check(rec.pwned === undefined, () => "T1 projectQuery '__proto__' injected a field");
        check(Object.getPrototypeOf(rec) === Object.prototype,
            () => "T1 projectQuery record prototype hijacked");
        check({}.pwned === undefined, () => "T1 projectQuery polluted Object.prototype");
        v.dispose();
    }
    // Symbol-keyed draft survives commit.
    {
        const F = Symbol("field");
        const { qc, data, raw } = makeQC({ name: "ada" });
        const v = projectQuery(qc, "k", { data });
        v.set(F, "sym");
        check(v.dirtyCount() === 1, () => "T1 projectQuery symbol draft not dirty");
        v.commit();
        check(raw()[F] === "sym", () => "T1 projectQuery symbol draft dropped by merge");
        check(v.dirtyCount() === 0, () => "T1 projectQuery symbol dirty after commit");
        v.dispose();
    }
    // Own-keys-only merge: an inherited property on the prev record is not copied.
    {
        const proto = { inherited: "no" };
        const prev = Object.create(proto);
        prev.real = 1;
        const { qc, data, raw } = makeQC(prev);
        const v = projectQuery(qc, "k", { data });
        v.set("added", 2);
        v.commit();
        check(raw().real === 1, () => "T1 projectQuery lost an own field");
        check(raw().added === 2, () => "T1 projectQuery draft did not land");
        check(!Object.prototype.hasOwnProperty.call(raw(), "inherited"),
            () => "T1 projectQuery merge copied an inherited property");
        v.dispose();
    }
}
