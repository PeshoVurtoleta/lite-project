/**
 * T0 -- metamorphic laws. Six algebraic properties the projection must satisfy
 * over a seeded corpus, each on a fresh view+source+oracle so a law never
 * inherits another law's state. Between phases only: validate() and direct
 * public-surface reads, never a measured hot path.
 */
import { project, keyedStore, confirmOnEcho } from "../../Project.js";
import { SEED, makePrng, frac, check } from "./harness.mjs";

const KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const TRIALS = 64;

function seededBacking(prng) {
    const seed = {};
    for (const k of KEYS) seed[k] = (frac(prng) * 1000) | 0;
    return keyedStore(seed);
}

export function run() {
    const prng = makePrng(SEED ^ 0x7010);

    // Law 1 -- revert-identity: any set sequence, then revert(), returns every
    // key to its pre-overlay effective value (the source), dirtyCount() to 0.
    for (let t = 0; t < TRIALS; t++) {
        const src = seededBacking(prng);
        const v = project(src);
        const before = new Map(KEYS.map((k) => [k, v.get(k)]));
        for (let i = 0; i < 12; i++) {
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            v.set(k, (frac(prng) * 1000) | 0);
        }
        v.revert();
        check(v.dirtyCount() === 0, () => "L1 revert left dirtyCount " + v.dirtyCount());
        for (const k of KEYS) {
            check(Object.is(v.get(k), before.get(k)),
                () => "L1 revert did not restore " + k);
        }
        v.dispose();
    }

    // Law 2 -- commit-then-source-read == last staged value.
    for (let t = 0; t < TRIALS; t++) {
        const src = seededBacking(prng);
        const v = project(src);
        const last = new Map();
        for (let i = 0; i < 12; i++) {
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            const val = (frac(prng) * 1000) | 0;
            v.set(k, val); last.set(k, val);
        }
        v.commit();
        for (const [k, val] of last) {
            check(Object.is(src.get(k), val),
                () => "L2 source not equal last staged for " + k);
            check(!v.isOverlaid(k), () => "L2 overlay survived commit for " + k);
        }
        v.dispose();
    }

    // Law 3 -- masking: while a key is overlaid, a source write to that key does
    // NOT change the projected value.
    for (let t = 0; t < TRIALS; t++) {
        const src = seededBacking(prng);
        const v = project(src);
        const k = KEYS[(frac(prng) * KEYS.length) | 0];
        const staged = 0xBEEF;
        v.set(k, staged);
        src.set(k, (frac(prng) * 1000) | 0 ^ 0x1234);
        check(Object.is(v.get(k), staged), () => "L3 source write pierced the mask on " + k);
        check(Object.is(v.peek(k), staged), () => "L3 peek pierced the mask on " + k);
        v.dispose();
    }

    // Law 4 -- reconcileAll idempotence: applying it twice equals once.
    for (let t = 0; t < TRIALS; t++) {
        const src = seededBacking(prng);
        const v = project(src);
        for (let i = 0; i < 8; i++) {
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            // half the drafts echo the source (droppable), half conflict (kept)
            v.set(k, frac(prng) < 0.5 ? src.get(k) : (src.get(k) ^ 0xFF) >>> 0);
        }
        v.reconcileAll(confirmOnEcho);
        const after = v.overlaidCount();
        v.reconcileAll(confirmOnEcho);
        check(v.overlaidCount() === after, () => "L4 reconcileAll not idempotent");
        v.dispose();
    }

    // Law 5 -- per-key commit over all keys == commit-all.
    for (let t = 0; t < TRIALS; t++) {
        const seedVals = KEYS.map(() => (frac(prng) * 1000) | 0);
        const stage = KEYS.map(() => (frac(prng) * 1000) | 0);

        const srcA = keyedStore(Object.fromEntries(KEYS.map((k, i) => [k, seedVals[i]])));
        const vA = project(srcA);
        KEYS.forEach((k, i) => vA.set(k, stage[i]));
        KEYS.forEach((k) => vA.commit(k));

        const srcB = keyedStore(Object.fromEntries(KEYS.map((k, i) => [k, seedVals[i]])));
        const vB = project(srcB);
        KEYS.forEach((k, i) => vB.set(k, stage[i]));
        vB.commit();

        for (const k of KEYS) {
            check(Object.is(srcA.get(k), srcB.get(k)),
                () => "L5 per-key commit diverged from commit-all on " + k);
        }
        check(vA.dirtyCount() === 0 && vB.dirtyCount() === 0,
            () => "L5 dirtyCount not zero after commit");
        vA.dispose(); vB.dispose();
    }

    // Law 6 -- dirtyCount() always equals the true overlaid count, through a
    // randomised set/clear stream.
    for (let t = 0; t < TRIALS; t++) {
        const src = seededBacking(prng);
        const v = project(src);
        const live = new Set();
        for (let i = 0; i < 24; i++) {
            const k = KEYS[(frac(prng) * KEYS.length) | 0];
            if (frac(prng) < 0.6) { v.set(k, i); live.add(k); }
            else { v.clear(k); live.delete(k); }
            check(v.dirtyCount() === live.size,
                () => "L6 dirtyCount " + v.dirtyCount() + " != true overlaid " + live.size);
            check(v.overlaidCount() === live.size,
                () => "L6 overlaidCount desync");
        }
        v.dispose();
    }
}
