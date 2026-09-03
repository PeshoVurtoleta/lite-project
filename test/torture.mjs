/**
 * test/torture.mjs -- the @zakkster/lite-project torture gate.
 *
 * Runs the wired tiers strictly in sequence (lite-gc-profiler is one-measurement-
 * at-a-time; tiers never nest), prints exactly "ok" on stdout on success (exit 0),
 * and on any failure writes a replay seed to stderr (exit 1). No gate output is a
 * FAIL -- silence never means pass.
 *
 *   npm run torture
 *   TORTURE_SEED=123 node --expose-gc test/torture.mjs      # replay a failure
 *
 * Node's `node --test` auto-discovers files under test/, so it also spawns this
 * orchestrator as a subprocess. Under the test runner it must be an inert no-op:
 * the tiers are not node:test files, and this runner's process.exit()/gc contract
 * does not belong in the harness.
 */
import { SEED, installRegistry, metrics } from "./torture/harness.mjs";
import { run as t0 } from "./torture/t0-laws.mjs";
import { run as t1 } from "./torture/t1-degenerate.mjs";
import { run as t4 } from "./torture/t4-reconcile.mjs";
import { run as t5 } from "./torture/t5-fuzz.mjs";
import { run as t6 } from "./torture/t6-alloc.mjs";
import { run as t7 } from "./torture/t7-soak.mjs";
import { run as t9 } from "./torture/t9-controls.mjs";

const TIERS = [
    ["T0 laws", t0],
    ["T1 degenerate", t1],
    ["T4 reconcile", t4],
    ["T5 fuzz", t5],
    ["T6 alloc", t6],
    ["T7 soak", t7],
    ["T9 controls", t9],
];

async function main() {
    if (process.env.NODE_TEST_CONTEXT !== undefined) return;

    if (typeof globalThis.gc !== "function") {
        process.stderr.write(
            "torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n");
        process.exit(1);
    }

    installRegistry();

    for (const [name, run] of TIERS) {
        try {
            await run();
        } catch (err) {
            process.stderr.write(
                "torture: FAIL -- " + name + " threw: " + ((err && err.stack) || err) +
                "\n  replay: TORTURE_SEED=" + SEED + " node --expose-gc test/torture.mjs\n");
            process.exit(1);
        }
    }

    process.stderr.write(
        "GATE leak=size " + metrics.leakSize + "/0" +
        " findings=" + metrics.leakFindings +
        " warnings=" + metrics.leakWarnings +
        " | gc major=" + metrics.gcMajor +
        " minor=" + metrics.gcMinor +
        " maxMs=" + metrics.gcMaxMs.toFixed(2) +
        " | alloc=" + (typeof metrics.allocBytesPerOp === "number"
            ? metrics.allocBytesPerOp.toFixed(2) + " B/op"
            : "n/a") +
        " retained=" + (typeof metrics.allocRetainedBytesPerCall === "number"
            ? metrics.allocRetainedBytesPerCall.toFixed(2) + " B/op"
            : "n/a") +
        " growths=" + metrics.poolGrowths + "\n");

    process.stdout.write("ok\n");
    process.exit(0);
}

main();
