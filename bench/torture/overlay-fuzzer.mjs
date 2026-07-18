/**
 * bench/torture/overlay-fuzzer.mjs -- seeded, oracle-checked projection soak.
 *
 * Not a benchmark -- CORRECTNESS detection for the draft/overlay layer:
 *
 *   - projectQuery FUZZ  random set/clear/commit(field)/commit-all/revert plus
 *     external cache writes (which drive auto-reconcile). After every step the
 *     draft view (get / isOverlaid / dirtyCount) and the query cache match a plain
 *     overlay+record oracle, and every commit is a single cache write.
 *   - core project FUZZ  random overlay churn over a fromAccessors reactive source;
 *     peek/get/isOverlaid/dirtyCount and the committed-through backing match an
 *     oracle across set/clear/commit/commit-all/revert.
 *
 * Exit code: 0 on clean run, 1 on any assertion failure.
 * Usage: node bench/torture/overlay-fuzzer.mjs            (TORTURE_SCALE=10 to crank)
 *
 * NOTE: installs a roomy default registry with onCapacityExceeded:"grow" (the
 * default-bound adapters use the default lite-signal registry).
 */
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";
import { createRegistry, setDefaultRegistry, signal as dSignal } from "@zakkster/lite-signal";
import { projectQuery, project, fromAccessors } from "../../Project.js";

setDefaultRegistry(createRegistry({ maxNodes: 1 << 20, maxLinks: 1 << 22, onCapacityExceeded: "grow" }));
const SCALE = Math.max(1, Number(process.env.TORTURE_SCALE) || 1);
const ri = (rand, n) => Math.floor(rand() * n);
function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function makeQueryClientLike() {
    const cache = new Map();
    const ks = (key) => JSON.stringify(key);
    const entry = (key) => {
        const k = ks(key);
        let e = cache.get(k);
        if (e === undefined) { e = { sig: dSignal(undefined, { equals: () => false }), value: undefined }; cache.set(k, e); }
        return e;
    };
    let writes = 0;
    return {
        getQueryData: (key) => entry(key).value,
        setQueryData: (key, v) => { writes++; const e = entry(key); e.value = typeof v === "function" ? v(e.value) : v; e.sig.set(e.value); return e.value; },
        data: (key) => () => { const e = entry(key); e.sig(); return e.value; },
        writes: () => writes,
    };
}
const FIELDS = ["a", "b", "c", "d", "e"];
const spread = (prev, ov) => ({ ...(prev || {}), ...ov });

function projectQueryFuzz() {
    const rand = rng(0xF00D);
    const qc = makeQueryClientLike();
    const KEY = ["rec", 1];
    let cache = { a: 0, b: 0, c: 0, d: 0, e: 0 };
    qc.setQueryData(KEY, { ...cache });
    const overlay = new Map();
    const p = projectQuery(qc, KEY, { data: qc.data(KEY) });
    const reconcile = () => { for (const f of [...overlay.keys()]) if (Object.is(cache[f], overlay.get(f))) overlay.delete(f); };
    const check = (i) => {
        for (const f of FIELDS) {
            const expect = overlay.has(f) ? overlay.get(f) : cache[f];
            assert.equal(p.get(f), expect, `get(${f}) iter ${i}`);
            assert.equal(p.isOverlaid(f), overlay.has(f), `isOverlaid(${f}) iter ${i}`);
        }
        assert.equal(p.dirtyCount(), overlay.size, `dirtyCount iter ${i}`);
        assert.equal(p.isDirty(), overlay.size > 0, `isDirty iter ${i}`);
        assert.deepEqual(qc.getQueryData(KEY), cache, `cache iter ${i}`);
    };
    check(-1);
    const ITERS = 4000 * SCALE;
    for (let i = 0; i < ITERS; i++) {
        const op = ri(rand, 6);
        if (op === 0) { const f = FIELDS[ri(rand, 5)], v = ri(rand, 10); p.set(f, v); overlay.set(f, v); }
        else if (op === 1) { const f = FIELDS[ri(rand, 5)]; p.clear(f); overlay.delete(f); }
        else if (op === 2) { const f = FIELDS[ri(rand, 5)], w = qc.writes(); p.commit(f); if (overlay.has(f)) { assert.equal(qc.writes() - w, 1, `commit(${f}) one write iter ${i}`); cache = spread(cache, { [f]: overlay.get(f) }); reconcile(); } else assert.equal(qc.writes() - w, 0, `no-op commit iter ${i}`); }
        else if (op === 3) { const w = qc.writes(), had = overlay.size > 0; p.commit(); if (had) { assert.equal(qc.writes() - w, 1, `commit-all one write iter ${i}`); const ov = {}; for (const [f, v] of overlay) ov[f] = v; cache = spread(cache, ov); overlay.clear(); } else assert.equal(qc.writes() - w, 0, `empty commit-all iter ${i}`); }
        else if (op === 4) { p.revert(); overlay.clear(); }
        else { const rec = {}; for (const f of FIELDS) rec[f] = ri(rand, 10); qc.setQueryData(KEY, rec); cache = rec; reconcile(); }
        check(i);
    }
    p.dispose();
    return `${(4000 * SCALE).toLocaleString()} ops; view+cache+single-write oracle held`;
}

function coreProjectFuzz() {
    const rand = rng(0xBEEF);
    const cells = new Map();
    const cell = (k) => { let s = cells.get(k); if (s === undefined) { s = dSignal(0); cells.set(k, s); } return s; };
    for (const f of FIELDS) cell(f);
    const source = fromAccessors((k) => cell(k)(), (k, v) => cell(k).set(v));
    const p = project(source);
    const overlay = new Map();
    const check = (i) => {
        for (const f of FIELDS) {
            const expect = overlay.has(f) ? overlay.get(f) : cell(f).peek();
            assert.equal(p.peek(f), expect, `peek(${f}) iter ${i}`);
            assert.equal(p.get(f), expect, `get(${f}) iter ${i}`);
            assert.equal(p.isOverlaid(f), overlay.has(f), `isOverlaid(${f}) iter ${i}`);
        }
        assert.equal(p.dirtyCount(), overlay.size, `dirtyCount iter ${i}`);
        assert.equal(p.overlaidCount(), overlay.size, `overlaidCount iter ${i}`);
    };
    check(-1);
    const ITERS = 5000 * SCALE;
    for (let i = 0; i < ITERS; i++) {
        const op = ri(rand, 6);
        if (op === 0) { const f = FIELDS[ri(rand, 5)], v = ri(rand, 100); p.set(f, v); overlay.set(f, v); }
        else if (op === 1) { const f = FIELDS[ri(rand, 5)]; p.clear(f); overlay.delete(f); }
        else if (op === 2) { const f = FIELDS[ri(rand, 5)]; p.commit(f); if (overlay.has(f)) { cell(f).set(overlay.get(f)); overlay.delete(f); } }
        else if (op === 3) { const staged = [...overlay.entries()]; p.commit(); for (const [f, v] of staged) cell(f).set(v); overlay.clear(); }
        else if (op === 4) { p.revert(); overlay.clear(); }
        else { const f = FIELDS[ri(rand, 5)]; cell(f).set(ri(rand, 100)); }
        check(i);
    }
    p.dispose();
    return `${(5000 * SCALE).toLocaleString()} ops; peek/get/dirty vs backing oracle held`;
}

const t0 = performance.now();
let failures = 0;
function run(name, fn) {
    const s = performance.now();
    try { const info = fn(); console.log(`  PASS ${name}${info ? " -- " + info : ""} (${((performance.now() - s) / 1000).toFixed(2)}s)`); }
    catch (e) { failures++; console.error(`  FAIL ${name}: ${e.message}`); }
}

console.log(`lite-project overlay fuzzer (seeded, oracle-checked; scale ${SCALE})`);
run("projectQuery draft/commit/reconcile fuzz", projectQueryFuzz);
run("core project() overlay fuzz", coreProjectFuzz);
console.log(`${failures ? "FAIL" : "PASS"}: ${failures} failure(s) in ${((performance.now() - t0) / 1000).toFixed(2)}s`);
process.exit(failures ? 1 : 0);
