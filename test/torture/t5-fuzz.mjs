/**
 * T5 -- gated oracle fuzz. A descendant of bench/torture/overlay-fuzzer.mjs (the
 * bench stays byte-identical): the same op mix -- set / clear / commit(key) /
 * commit-all / revert + external source writes + reconcileAll -- driven against a
 * plain-Map oracle at EVERY step, PLUS object-valued drafts and structural-twin
 * echoes (F-03's shape, which the scalar bench fuzzer misses). Runs under the
 * pre-grown "throw" registry. Every projectQuery.commit is exactly one
 * setQueryData write. validate() after every op.
 */
import { project, projectQuery, keyedStore } from "../../Project.js";
import { signal } from "@zakkster/lite-signal";
import { SEED, makePrng, frac, check, makeOracle, validate } from "./harness.mjs";

const KEYS = ["a", "b", "c", "d", "e"];
const SEQS = 40;
const OPS = 200;

// A small pool of values: scalars plus fresh object references so object-valued
// drafts and structural twins enter the corpus.
function pick(prng) {
    const r = frac(prng);
    if (r < 0.7) return (frac(prng) * 10) | 0;         // scalar
    return { n: (frac(prng) * 4) | 0 };                // object (fresh reference each call)
}

function coreFuzz() {
    for (let seq = 0; seq < SEQS; seq++) {
        const prng = makePrng((SEED ^ 0x5011) + seq);
        const oracle = makeOracle();
        const seed = {};
        for (const k of KEYS) { const val = (frac(prng) * 10) | 0; seed[k] = val; oracle.src.set(k, val); }
        const src = keyedStore(seed);
        const v = project(src);

        for (let i = 0; i < OPS; i++) {
            const op = (frac(prng) * 7) | 0;
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            if (op === 0) { const val = pick(prng); v.set(k, val); oracle.ov.set(k, val); }
            else if (op === 1) { v.clear(k); oracle.ov.delete(k); }
            else if (op === 2) {
                v.commit(k);
                if (oracle.ov.has(k)) { oracle.src.set(k, oracle.ov.get(k)); oracle.ov.delete(k); }
            } else if (op === 3) {
                // Metamorphic law: the emitted patch applied to a fresh copy of
                // the source produces the SAME state as commit() into it. `from`
                // must equal the current source value at every emitted key.
                const copy = new Map(oracle.src);
                v.forEachPatch((pk, pf, pt) => {
                    check(Object.is(pf, oracle.src.get(pk)),
                        () => "T5 patch from " + String(pf) + " != source " + String(oracle.src.get(pk)) + " at " + String(pk));
                    copy.set(pk, pt);
                });
                v.commit();
                for (const [dk, dv] of oracle.ov) oracle.src.set(dk, dv);
                oracle.ov.clear();
                check(copy.size === oracle.src.size,
                    () => "T5 patch/commit size " + copy.size + " != " + oracle.src.size);
                for (const [dk, dv] of oracle.src) {
                    check(copy.has(dk) && Object.is(copy.get(dk), dv),
                        () => "T5 patch-apply != commit at " + String(dk));
                }
                for (const [dk] of copy) {
                    check(oracle.src.has(dk), () => "T5 patch-apply produced extra key " + String(dk));
                }
            } else if (op === 4) { v.revert(); oracle.ov.clear(); }
            else if (op === 5) {
                const val = pick(prng); src.set(k, val); oracle.src.set(k, val); // authoritative write
            } else {
                // reconcileAll(default Object.is): drop overlays the source echoes
                // by REFERENCE; a structural twin (fresh object) is NOT dropped.
                v.reconcileAll();
                for (const [dk, dv] of [...oracle.ov]) {
                    if (Object.is(oracle.src.get(dk), dv)) oracle.ov.delete(dk);
                }
            }
            validate(v, null, oracle);
        }
        v.dispose();
    }
}

function makeQC() {
    let store = { a: 0, b: 0, c: 0, d: 0, e: 0 };
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

function queryFuzz() {
    for (let seq = 0; seq < SEQS; seq++) {
        const prng = makePrng((SEED ^ 0x9011) + seq);
        const h = makeQC();
        const v = projectQuery(h.qc, "rec", { data: h.data });
        const oracle = makeOracle();
        // Mirror the cache record fields into oracle.src.
        const syncSrc = () => { const rec = h.raw(); oracle.src.clear(); for (const k of KEYS) oracle.src.set(k, rec[k]); };
        syncSrc();

        for (let i = 0; i < OPS; i++) {
            const op = (frac(prng) * 6) | 0;
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            if (op === 0) { const val = pick(prng); v.set(k, val); oracle.ov.set(k, val); }
            else if (op === 1) { v.clear(k); oracle.ov.delete(k); }
            else if (op === 2) {
                const had = oracle.ov.has(k);
                const w0 = h.writes();
                v.commit(k);
                if (had) {
                    check(h.writes() - w0 === 1, () => "T5 query commit(field) not exactly one write");
                    oracle.ov.delete(k);
                    syncSrc();
                    // auto-reconcile fired on the write: drop echoed overlays by ref
                    for (const [dk, dv] of [...oracle.ov]) if (Object.is(oracle.src.get(dk), dv)) oracle.ov.delete(dk);
                } else {
                    check(h.writes() - w0 === 0, () => "T5 query no-op commit wrote");
                }
            } else if (op === 3) {
                const had = oracle.ov.size > 0;
                const w0 = h.writes();
                v.commit();
                if (had) {
                    check(h.writes() - w0 === 1, () => "T5 query commit-all not exactly one write");
                    oracle.ov.clear();
                    syncSrc();
                } else {
                    check(h.writes() - w0 === 0, () => "T5 query empty commit-all wrote");
                }
            } else if (op === 4) { v.revert(); oracle.ov.clear(); }
            else {
                // external cache write drives auto-reconcile
                const rec = {}; for (const f of KEYS) rec[f] = (frac(prng) * 10) | 0;
                h.qc.setQueryData("rec", rec);
                syncSrc();
                for (const [dk, dv] of [...oracle.ov]) if (Object.is(oracle.src.get(dk), dv)) oracle.ov.delete(dk);
            }
            validate(v, null, oracle);
        }
        v.dispose();
    }
}

export function run() {
    coreFuzz();
    queryFuzz();
}
