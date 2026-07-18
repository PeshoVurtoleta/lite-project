// projectQuery adapter suite for @zakkster/lite-project 1.1.
//
// projectQuery(qc, key, opts?) projects ONE lite-query entry's data OBJECT as a
// draft overlay whose projected keys are the FIELDS of that object, and commits
// staged field drafts back into the cache as a SINGLE setQueryData write. The
// adapter is default-registry-bound (like projectStore / projectRoom), so these
// tests use the default lite-signal registry and a structural lite-query fake.
//
// Run: node --test test/query_test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { signal as dSignal, effect as dEffect } from "@zakkster/lite-signal";
import { projectQuery } from "../Project.js";

// lite-query client contract used by the adapter:
//   getQueryData(key)                 -> non-reactive cache peek
//   setQueryData(key, valueOrUpdater) -> write (updater gets prev); fires the entry
// Plus a reactive `data(key)` accessor mirroring `query.data` from createQuery.
function makeQueryClientLike(seed) {
    const cache = new Map();               // keyStr -> { sig, value }
    const ks = (key) => JSON.stringify(key);
    const entry = (key) => {
        const k = ks(key);
        let e = cache.get(k);
        if (e === undefined) { e = { sig: dSignal(undefined, { equals: () => false }), value: undefined }; cache.set(k, e); }
        return e;
    };
    let writes = 0;
    const qc = {
        getQueryData: (key) => entry(key).value,
        setQueryData: (key, valueOrFn) => {
            writes++;
            const e = entry(key);
            const next = typeof valueOrFn === "function" ? valueOrFn(e.value) : valueOrFn;
            e.value = next;
            e.sig.set(next);               // fire reactive readers (data accessor)
            return next;
        },
        // reactive accessor for a key's record (pass as opts.data)
        data: (key) => () => { const e = entry(key); e.sig(); return e.value; },
        writes: () => writes,
    };
    if (seed) for (const k in seed) qc.setQueryData(k, seed[k]);
    writes = 0;                            // don't count seeding
    return qc;
}

// -- Draft + single-write commit ---------------------------------------------

test("draft over a query record; commit merges into the cache in ONE write", () => {
    const qc = makeQueryClientLike({ user: { name: "alice", age: 30 } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });

    assert.equal(p.get("name"), "alice");
    p.set("name", "bob");
    p.set("age", 31);
    assert.equal(p.get("name"), "bob");                    // draft visible
    assert.deepEqual(qc.getQueryData("user"), { name: "alice", age: 30 }); // cache untouched

    p.commit();
    assert.equal(qc.writes(), 1, "all field drafts committed in a single setQueryData");
    assert.deepEqual(qc.getQueryData("user"), { name: "bob", age: 31 }, "fields merged, none lost");
    assert.equal(p.isOverlaid("name"), false);
    assert.equal(p.isDirty(), false);
    p.dispose();
});

test("commit preserves untouched fields (merge is shallow spread by default)", () => {
    const qc = makeQueryClientLike({ post: { title: "hi", body: "x", tags: ["a"] } });
    const p = projectQuery(qc, "post", { data: qc.data("post") });
    p.set("title", "hello");
    p.commit();
    assert.deepEqual(qc.getQueryData("post"), { title: "hello", body: "x", tags: ["a"] });
    p.dispose();
});

test("commit(field) writes and clears only that field", () => {
    const qc = makeQueryClientLike({ user: { a: 1, b: 2 } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    p.set("a", 10);
    p.set("b", 20);
    p.commit("a");
    assert.equal(qc.writes(), 1);
    assert.deepEqual(qc.getQueryData("user"), { a: 10, b: 2 }, "only a committed");
    assert.equal(p.isOverlaid("a"), false);
    assert.equal(p.isOverlaid("b"), true, "b draft still staged");
    p.dispose();
});

test("revert discards drafts without touching the cache", () => {
    const qc = makeQueryClientLike({ user: { name: "alice" } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    p.set("name", "bob");
    assert.equal(p.isDirty(), true);
    p.revert();
    assert.equal(p.isDirty(), false);
    assert.equal(p.get("name"), "alice");
    assert.equal(qc.writes(), 0, "revert never wrote to the cache");
    p.dispose();
});

// -- Reactive reads ----------------------------------------------------------

test("projected reads track the query cache when opts.data is supplied", () => {
    const qc = makeQueryClientLike({ user: { name: "alice" } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    let shown, runs = 0;
    const stop = dEffect(() => { shown = p.get("name"); runs++; });
    assert.equal(shown, "alice");

    qc.setQueryData("user", { name: "carol" });            // external cache update (e.g. refetch)
    assert.equal(shown, "carol", "reader re-ran with the new authoritative value");
    assert.ok(runs >= 2);
    stop(); p.dispose();
});

test("a draft masks the authoritative value in reactive reads", () => {
    const qc = makeQueryClientLike({ user: { n: 0 } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    let shown;
    const stop = dEffect(() => { shown = p.get("n"); });
    p.set("n", 9);
    assert.equal(shown, 9, "overlay overrides the cache in the read");
    stop(); p.dispose();
});

// -- Auto-reconcile (echo) ---------------------------------------------------

test("auto-reconcile drops a draft when the cache catches up (echo)", () => {
    const qc = makeQueryClientLike({ user: { k: 0 } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    p.set("k", 5);
    assert.equal(p.isOverlaid("k"), true);

    qc.setQueryData("user", { k: 5 });                     // server confirms 5
    assert.equal(p.isOverlaid("k"), false, "echo confirmed -> draft dropped");
    assert.equal(p.get("k"), 5);
    p.dispose();
});

test("a conflicting authoritative value leaves the draft masked (no flicker)", () => {
    const qc = makeQueryClientLike({ user: { k: 0 } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    let shown;
    const stop = dEffect(() => { shown = p.get("k"); });
    p.set("k", 9);
    assert.equal(shown, 9);

    qc.setQueryData("user", { k: 7 });                     // diverges UNDER the overlay
    assert.equal(p.isOverlaid("k"), true, "7 != 9 -> not confirmed -> kept");
    assert.equal(shown, 9, "UI holds the optimistic value");
    stop(); p.dispose();
});

// -- Degraded mode (no opts.data) --------------------------------------------

test("without opts.data: base read is a non-reactive snapshot, commit still works", () => {
    const qc = makeQueryClientLike({ user: { name: "alice", age: 30 } });
    const p = projectQuery(qc, "user");                    // no data accessor
    assert.equal(p.get("name"), "alice");                  // snapshot read
    p.set("name", "bob");
    p.commit();
    assert.equal(qc.writes(), 1);
    assert.deepEqual(qc.getQueryData("user"), { name: "bob", age: 30 });
    // No auto-reconcile: an external write does NOT auto-drop an unrelated draft.
    p.set("age", 99);
    qc.setQueryData("user", { name: "bob", age: 99 });     // "confirms" 99
    assert.equal(p.isOverlaid("age"), true, "degraded mode does not auto-reconcile");
    p.dispose();
});

// -- merge option + empty cache ----------------------------------------------

test("opts.merge customizes how overlays fold into the record", () => {
    const qc = makeQueryClientLike({ doc: { meta: { v: 1 }, title: "a" } });
    // A merge that deep-merges the `meta` field.
    const merge = (prev, overlays) => {
        const out = { ...(prev || {}), ...overlays };
        if (prev && prev.meta && overlays.meta) out.meta = { ...prev.meta, ...overlays.meta };
        return out;
    };
    const p = projectQuery(qc, "doc", { data: qc.data("doc"), merge });
    p.set("meta", { note: "x" });
    p.commit();
    assert.deepEqual(qc.getQueryData("doc"), { meta: { v: 1, note: "x" }, title: "a" });
    p.dispose();
});

test("committing onto an empty cache entry seeds the record", () => {
    const qc = makeQueryClientLike();                      // nothing cached
    const p = projectQuery(qc, "fresh", { data: qc.data("fresh") });
    assert.equal(p.get("name"), undefined);
    p.set("name", "new");
    p.commit();
    assert.deepEqual(qc.getQueryData("fresh"), { name: "new" }, "merge(undefined, {...}) seeded it");
    p.dispose();
});

// -- Validation + lifecycle --------------------------------------------------

test("throws when qc lacks the required methods", () => {
    assert.throws(() => projectQuery(null, "k"), /getQueryData/);
    assert.throws(() => projectQuery({}, "k"), /getQueryData/);
    assert.throws(() => projectQuery({ getQueryData() {} }, "k"), /setQueryData/);
});

test("dispose stops auto-reconcile; later cache writes are inert for this view", () => {
    const qc = makeQueryClientLike({ user: { k: 0 } });
    const p = projectQuery(qc, "user", { data: qc.data("user") });
    p.set("k", 5);
    p.dispose();
    // After dispose the reconcile effect is stopped; a cache write must not throw.
    assert.doesNotThrow(() => qc.setQueryData("user", { k: 5 }));
});

test("array query keys work (serialized like lite-query)", () => {
    const qc = makeQueryClientLike();
    const key = ["users", 7];
    qc.setQueryData(key, { name: "z" });
    const p = projectQuery(qc, key, { data: qc.data(key) });
    assert.equal(p.get("name"), "z");
    p.set("name", "zed");
    p.commit();
    assert.deepEqual(qc.getQueryData(key), { name: "zed" });
    p.dispose();
});
