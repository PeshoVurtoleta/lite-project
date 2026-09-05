# 0002 -- Overlay TTL + partial commit (commitWhere / clearWhere)

Date: 2026-09-05
Status: accepted (v1.3.0)

Context: a pending overlay that never gets its ack has no way back, and F-03's
object-valued draft can never echo-confirm under `Object.is`. v1.3.0 adds an
overlay TTL that self-heals a stale draft on a deterministic injectable clock,
plus predicate-scoped partial commit / discard.

## Decision -- TTL fires a REVERT

`set(key, v, {ttl})` schedules an auto-REVERT at `now() + ttl`: drop the overlay,
the source is NEVER touched. "The optimistic edit expired; fall back to
authoritative." Commit-on-timeout is a DIFFERENT feature and out of scope
(a timeout is the failure path -- promoting an unconfirmed value into the source
on a timer is the opposite of fail-closed).

## One timer per projection, not a min-heap

ONE re-armed platform timer per projection. Each slot stores its own deadline as a
third field on the slot record (`{ ov, read, exp: 0 }`, `exp === 0` == no expiry),
initialized at slot creation so the hidden class is stable and a ttl set is one
field write -- never a side `Map<key, deadline>` (that is a per-key allocation on
the ttl branch). Arm/fire do an O(slots) cold scan for the earliest deadline. A
min-heap was rejected: it allocates per push, and arm/fire are cold anyway.
`clearTimer` runs only when the live-TTL count hits 0 and in `dispose()`. The arm
delay is clamped to `>= 0`. Invariant: `exp !== 0` implies overlaid, so `prune()`
needs no change and can never orphan a deadline.

## All-or-none injectable clock

`project(source, {now, setTimer, clearTimer})`. If ANY of the three is supplied,
all three must be functions, else `TypeError` -- a MIXED clock computes deadlines
on one timeline and arms the timer on another, so it fails closed. Defaults wrap
the platform globals in arrows (`() => performance.now()`, etc.): bare `setTimeout`
refs throw "Illegal invocation" in browsers, and `performance.now` is monotonic so
an NTP step cannot make a deadline unreachable (`setTimer` takes a DELTA, so only
monotonicity matters). A lying `now()` that returns a non-finite deadline throws
before the invariant is poisoned.

## Spurious-fire contract; re-set semantics

A re-set with an EARLIER deadline re-arms; a LATER one does not. When the earliest
deadline was cancelled, the armed timer fires spuriously: it reverts nothing due,
then re-arms for the true next-earliest. That is the contract, not a bug. The fire
handler re-arms AFTER its revert batch closes, so a subscriber's
`set(k, v, {ttl})` executed during the flush is honoured; `_armAt` clears any live
handle first, so at most ONE timer handle is ever outstanding. A subscriber that
THROWS during the batch close skips the `_rearm()` call -- the remaining deadlines
stay staged but unarmed (no handle leaked, no bag desync), and the next `set`
with a ttl, the next fire, or `dispose()` recovers: fail-closed, erring toward
"the draft stays" rather than dropping an overlay off an unarmed timeline. Post-dispose fire is
inert (slots cleared, ttlCount 0 -> early return) but `dispose()` still cancels the
pending handle (a live `setTimeout` would hold the event loop open for up to `ttl`
ms and retain the closure). A re-set WITHOUT `ttl` cancels the expiry: each `set`
fully specifies its overlay's lifetime. EVERY transition to ABSENT
(clear / commit(key) / commit() / revert / reconcileAll drop / commitWhere /
clearWhere / the fire itself) cancels that key's expiry.

## F-03 recorded, not "fixed" with a deep-equal

`confirmOnEcho` is reference-equality (`Object.is`). An object-valued draft can
never echo-confirm against a structurally-equal source value of a different
reference. The fix is a CALLER-supplied structural policy: `reconcileAll(policy)`
and the `forEachPatch` skip param already accept one. This library ships NO
deep-equal helper -- a naive structural equal (JSON round-trip, shallow compare) is
a fail-OPEN trap: it silently confirms drafts the caller did not mean to confirm,
and its scope (cycles, Dates, Maps, key order) is unbounded. The TTL is the shipped
safety net: an object draft that never confirms self-heals on its deadline.

## Partial ops -- commitWhere / clearWhere

`commitWhere(pred)` / `clearWhere(pred)` on the core handle, `pred(key, value)`
with `value` the STAGED overlay value (the `forEachOverlay` callback order, NOT
`ReconcilePolicy`'s). One batch each, insertion order, per-drop dirty bookkeeping.
A throwing pred is NON-atomic on the core handle: batch's `finally` still flushes,
already-committed keys stay committed, and `dirtyCount() === overlaidCount()`
(documented, no rollback).

`projectQuery.commitWhere` is OVERRIDDEN for a stronger all-or-nothing property: it
collects the matching fields into a null-prototype bag, issues ONE `setQueryData`
write, then clears the committed fields per-key inside a `_batch`. It must NOT reuse
the `commit()` override's `view.revert()` -- revert drops the NON-matching drafts
too (silent data loss) and its wholesale `dirty = 0` skips the per-key presence and
exp-cancellation bookkeeping. Per-field `view.clear` runs the same transition every
other site runs; the `_batch` folds the N `dirtySig` writes into one propagation.
`clearWhere` and TTL are pure overlay ops -> spread-inherited free by
projectRoom / projectQuery; projectStore / projectRoom need no override.

Dev-only. `decisions/` never enters `package.json` `files[]`.
