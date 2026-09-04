# 0001 -- Patch emission: unchanged drafts are emitted by default

Context: `forEachPatch` / `toPatch` (v1.2.0) expose the staged drafts as a
`(key, from, to)` stream. The open question was whether a draft whose staged
value equals the current source value (`Object.is(from, to)`) should be emitted
or silently filtered.

Decision:

> An overlaid key is emitted whether or not `Object.is(from, to)`. Three reasons.
> First, the visit set stays definitionally equal to `forEachOverlay`,
> `dirtyCount()`, and `commit()`'s write set; a silent filter would make
> `toPatch().length !== dirtyCount()` and turn every downstream count into a lie.
> Second, a patch consumer is a protocol, not a diff viewer: an LWW-Map op, a CRDT
> timestamp bump, and an HTTP PATCH field can all be load-bearing at an unchanged
> value, and dropping the key is silent data loss one layer out -- fail closed, do
> not infer that the peer does not need it. Third, F-03 means the case people
> actually want suppressed (a structurally-equal object echo) is "changed" under
> `Object.is` regardless, so skipping buys almost none of the noise reduction it
> promises while costing the count invariant. Callers who want the filter pass the
> same predicate shape reconcile uses: `forEachPatch(fn, confirmOnEcho)`. Default
> is `undefined` = emit all.
