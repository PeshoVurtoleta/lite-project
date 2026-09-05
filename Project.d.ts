// Type declarations for @zakkster/lite-project v1.4.0
// Zero-GC projections for @zakkster/lite-signal.
// (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT

export const VERSION: string;

/**
 * A reactive keyed source a projection can wrap. Any object with a reactive
 * `get(key)` and a `set(key, value)` qualifies (the built-in `keyedStore`, a
 * lite-store proxy via `fromProxy`, a plain pair via `fromAccessors`, ...).
 */
export interface ProjectionSource<K extends PropertyKey = PropertyKey, V = unknown> {
    /** Reactive read: tracks the cell backing `key`. */
    get(key: K): V;
    /** Write the underlying value for `key`. */
    set(key: K, value: V): void;
}

/**
 * Reconciliation policy. Given the current authoritative value, the staged
 * overlay value, and the key, return `true` to DROP the overlay (it is
 * "confirmed" -- the source has caught up), `false` to keep it (a conflict the
 * view should keep masking). Defaults to {@link confirmOnEcho}.
 */
export type ReconcilePolicy<K extends PropertyKey = PropertyKey, V = unknown> =
    (authoritative: V, overlayValue: V, key: K) => boolean;

/**
 * Options for a single {@link Projection.set}. `ttl` (a finite number > 0, in the
 * clock's units) auto-REVERTS the staged overlay at `now() + ttl` -- the source is
 * never touched. A bad `ttl` throws before staging; a re-set without `ttl` cancels
 * a prior expiry (each set fully specifies its overlay's lifetime).
 */
export interface SetOptions {
    ttl?: number;
}

/**
 * An injectable clock for overlay TTL. `now()` returns a monotonic number,
 * `setTimer(fn, ms)` schedules `fn` after `ms` and returns a handle, and
 * `clearTimer(handle)` cancels it. All-or-none: supply all three or none.
 */
export interface ProjectionClock {
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
}

/** Options for {@link project} / {@link Projector.project}: an optional injectable clock. */
export interface ProjectOptions extends Partial<ProjectionClock> {}

/**
 * One staged draft as a patch entry: the current source value (`from`) and the
 * staged overlay value (`to`) for `key`. The materialized shape returned by
 * {@link Projection.toPatch}.
 */
export interface Patch<K extends PropertyKey = PropertyKey, V = unknown> {
    key: K;
    from: V;
    to: V;
}

/**
 * A projection handle: a granular, derived, non-mutating draft overlay over a
 * keyed source. Each touched key owns one overlay signal + one projected
 * computed, created lazily and recycled by {@link Projection.dispose}.
 */
export interface Projection<K extends PropertyKey = PropertyKey, V = unknown> {
    /** Reactive: the overlay value if one is staged for `key`, else the source value. */
    get(key: K): V;
    /**
     * Stage an EPHEMERAL overlay for `key`. The source is NOT mutated. Pass
     * `{ ttl }` to auto-revert the overlay at `now() + ttl`; a re-set without
     * `ttl` cancels a pending expiry.
     */
    set(key: K, value: V, opts?: SetOptions): void;
    /** Drop one key's overlay (revert that key to the source). */
    clear(key: K): void;
    /** Untracked diagnostic: is `key` currently overlaid? */
    isOverlaid(key: K): boolean;
    /** Untracked diagnostic: number of currently-overlaid keys. */
    overlaidCount(): number;
    /**
     * TRACKED reactive count of staged overlays. Read it inside an effect/computed
     * to drive an "unsaved changes" badge or enable/disable Save without polling.
     * (Backed by one fixed signal per projection; updates are allocation-free.)
     */
    dirtyCount(): number;
    /** TRACKED reactive `dirtyCount() > 0`. */
    isDirty(): boolean;
    /** Untracked effective read (overlay if staged, else source) -- does not subscribe. */
    peek(key: K): V;
    /** Iterate currently-overlaid keys with their overlay values (untracked). */
    forEachOverlay(fn: (key: K, value: V) => void): void;
    /**
     * Emit the staged drafts as a patch stream `fn(key, from, to)` -- `from` is
     * the UNTRACKED current source value, `to` the staged overlay. Read-only and
     * untracked: it touches neither the source nor the overlays and subscribes the
     * caller to nothing, so it is safe inside an effect. Visits exactly the
     * overlaid keys, in {@link Projection.forEachOverlay} order, with a zero-alloc
     * per-key body. An overlaid key is emitted whether or not `Object.is(from, to)`
     * (the visit set stays equal to `dirtyCount()`); pass `skip` -- the same
     * predicate shape reconcile uses, e.g. {@link confirmOnEcho} -- to drop
     * unchanged drafts. A throwing `source.get` propagates on that key with the
     * overlay bag intact (callers needing atomicity use {@link Projection.toPatch}).
     */
    forEachPatch(fn: (key: K, from: V, to: V) => void, skip?: ReconcilePolicy<K, V>): void;
    /**
     * Cold convenience over {@link Projection.forEachPatch}: materialize the drafts
     * as `[{ key, from, to }, ...]` -- same visit set, order, and values. The
     * per-key record is this form's allocation; reach for `forEachPatch` when you
     * need the zero-alloc callback.
     */
    toPatch(skip?: ReconcilePolicy<K, V>): Array<Patch<K, V>>;
    /**
     * Full-snapshot reconciliation: drop every overlay the policy considers
     * confirmed against the current (untracked) source value. Presentation-only --
     * the source owns the real write.
     */
    reconcileAll(policy?: ReconcilePolicy<K, V>): void;
    /** Write staged overlays into the source, then clear them. With `key`, commits just that key. */
    commit(key?: K): void;
    /**
     * Predicate-scoped partial commit: write and clear only the overlaid keys for
     * which `pred(key, stagedValue)` returns true (the {@link Projection.forEachOverlay}
     * callback order), in one propagation. A throwing `pred` propagates with the
     * already-committed keys committed and `dirtyCount() === overlaidCount()`.
     */
    commitWhere(pred: (key: K, value: V) => boolean): void;
    /**
     * Predicate-scoped partial discard: drop only the overlaid keys for which
     * `pred(key, stagedValue)` returns true. The source is never touched.
     */
    clearWhere(pred: (key: K, value: V) => boolean): void;
    /** Drop all overlays. */
    revert(): void;
    /**
     * Release slots for keys that are neither overlaid nor observed, returning
     * how many were freed.
     *
     * A slot (one overlay signal + one projected computed) is created by the
     * first READ of a key and retained until `dispose()`, because its computed
     * may have live subscribers. Over a large or unbounded keyspace that is real
     * growth, and neither `commit()` nor `revert()` gives any of it back.
     *
     * `prune()` is the safe reclamation path: it skips any key with a staged
     * overlay (nothing to lose) and any whose projected read still has
     * observers. A pruned key rebuilds transparently on its next read.
     *
     * Cold path -- call it on a viewport change or after a commit, not per frame.
     * O(slots). Returns 0 on a custom registry that does not supply
     * `hasObservers`.
     */
    prune(): number;
    /** Recycle every projection-owned node back to the lite-signal pool. */
    dispose(): void;
}

/**
 * Minimal built-in keyed reactive source: one lazily-created signal per key.
 * Provided so a projection has something to wrap out of the box; for richer
 * needs use a lite-store proxy (via {@link fromProxy}) instead.
 */
export interface KeyedStore<K extends PropertyKey = PropertyKey, V = unknown> {
    /** Reactive read (tracks `key`'s signal). `undefined` until set. */
    get(key: K): V | undefined;
    /** Write `key`'s signal (fires consumers through Object.is). */
    set(key: K, value: V): void;
    /** Untracked: has `key` ever been touched? */
    has(key: K): boolean;
    /** Untracked: iterator over touched keys. */
    keys(): IterableIterator<K>;
}

/**
 * The subset of a lite-signal registry the projector needs. Pass the default
 * namespace, or a `createRegistry({...})` result for an isolated graph.
 */
export interface ProjectorRegistry {
    signal(initial: unknown, opts?: unknown): unknown;
    computed(fn: () => unknown, opts?: unknown): unknown;
    createRoot<T>(fn: () => T): T;
    dispose(handle: unknown): void;
    untrack<T>(fn: () => T): T;
    /**
     * Optional. Coalesces the multi-signal writes in commit / revert /
     * reconcileAll into one propagation so a multi-key consumer never sees a
     * torn snapshot. Omit it and those writes propagate one at a time.
     */
    batch?<T>(fn: () => T): T;
    /**
     * Optional. Required by {@link Projection.prune}, which uses it to tell a
     * slot nobody is subscribed to from one a consumer still depends on. Omit it
     * and `prune()` safely reclaims nothing and returns 0.
     */
    hasObservers?(handle: unknown): boolean;
}

/** The registry-bound projection primitives returned by {@link createProjector}. */
export interface Projector {
    project<K extends PropertyKey = PropertyKey, V = unknown>(
        source: ProjectionSource<K, V>,
        opts?: ProjectOptions,
    ): Projection<K, V>;
    keyedStore<K extends PropertyKey = PropertyKey, V = unknown>(
        initial?: Record<PropertyKey, V>,
    ): KeyedStore<K, V>;
}

/** Bind the projection primitives to a lite-signal registry. */
export function createProjector(reg: ProjectorRegistry): Projector;

/** Project a keyed source (default registry). */
export function project<K extends PropertyKey = PropertyKey, V = unknown>(
    source: ProjectionSource<K, V>,
    opts?: ProjectOptions,
): Projection<K, V>;

/** Minimal built-in keyed reactive source (default registry). */
export function keyedStore<K extends PropertyKey = PropertyKey, V = unknown>(
    initial?: Record<PropertyKey, V>,
): KeyedStore<K, V>;

/**
 * Default reconciliation policy: an overlay is confirmed once the authoritative
 * value equals the optimistic one (the source echoed it back). `Object.is`.
 */
export function confirmOnEcho(authoritative: unknown, overlayValue: unknown): boolean;

/** Shape a plain accessor pair into a projection source. */
export function fromAccessors<K extends PropertyKey = PropertyKey, V = unknown>(
    get: (key: K) => V,
    set: (key: K, value: V) => void,
): ProjectionSource<K, V>;

/**
 * Shape a property-style reactive store (a Proxy, or a lite-store proxy) into a
 * projection source. `obj[key]` must be a TRACKED read and `obj[key] = v` a write.
 */
export function fromProxy<V = unknown>(
    obj: Record<PropertyKey, V>,
): ProjectionSource<PropertyKey, V>;

/**
 * Per-key reconciler for an authoritative source with an incoming-update event
 * (a CRDT room, a socket). Wire the returned handler to that event: when an
 * update arrives for an overlaid key and `policy` confirms it, the overlay is
 * dropped. Presentation-only -- the source owns the real write and merge.
 */
export function makeReconciler<K extends PropertyKey = PropertyKey, V = unknown>(
    view: Pick<Projection<K, V>, "isOverlaid" | "peek" | "clear">,
    policy?: ReconcilePolicy<K, V>,
): (key: K, authoritativeValue: V) => void;

// ---- library adapters --------------------------------------------------------

/**
 * Project a @zakkster/lite-store proxy as a DRAFT overlay. Inherits lite-store's
 * per-key granularity; `commit()` writes drafts through to the store. Projects
 * the top-level keys of the given proxy (pass a nested proxy to project deeper).
 */
export function projectStore<V = unknown>(
    store: Record<PropertyKey, V>,
    opts?: ProjectOptions,
): Projection<PropertyKey, V>;

/** The subset of a @zakkster/lite-room handle that {@link projectRoom} consumes. */
export interface RoomLike {
    storage: {
        get(key: string): unknown;
        set(key: string, value: unknown): boolean | void;
        /** The coarse `entries` change signal (read to subscribe). */
        entries(): unknown;
    };
}

/** Options for {@link projectRoom}. Extends the injectable clock for overlay TTL. */
export interface ProjectRoomOptions extends Partial<ProjectionClock> {
    /** Reconciliation policy; defaults to {@link confirmOnEcho}. */
    policy?: ReconcilePolicy<string, unknown>;
}

/**
 * Project a @zakkster/lite-room's LWW-Map (`room.storage`) as a DRAFT layer for
 * optimistic / tentative UI. `set` stages a local draft, `commit()` promotes it
 * via `room.storage.set` (writes + syncs), and an auto-reconcile drops drafts the
 * authoritative state catches up to while leaving conflicts masked. The returned
 * handle's `dispose()` also stops the reconcile effect.
 */
export function projectRoom(
    room: RoomLike,
    opts?: ProjectRoomOptions,
): Projection<string, unknown>;

/** The subset of a @zakkster/lite-query client that {@link projectQuery} consumes. */
export interface QueryClientLike {
    /** Non-reactive cache peek for a key. */
    getQueryData(key: unknown): unknown;
    /** Write a key's data; an updater function receives the previous value. */
    setQueryData(key: unknown, valueOrUpdater: unknown | ((prev: unknown) => unknown)): unknown;
}

/** Options for {@link projectQuery}. Extends the injectable clock for overlay TTL. */
export interface ProjectQueryOptions<V extends object = Record<PropertyKey, unknown>>
    extends Partial<ProjectionClock> {
    /**
     * The query's reactive data accessor (e.g. `query.data`). When supplied,
     * projected reads track the cache and auto-reconcile is armed. Omit to degrade
     * to a non-reactive `getQueryData` snapshot with no auto-reconcile.
     */
    data?: () => V | null | undefined;
    /** Reconciliation policy for auto-reconcile; defaults to {@link confirmOnEcho}. */
    policy?: ReconcilePolicy<keyof V, unknown>;
    /** Fold staged field overlays into the record; defaults to a shallow spread `{ ...prev, ...overlays }`. */
    merge?: (prev: V | null | undefined, overlays: Partial<V>) => V;
}

/**
 * Project ONE @zakkster/lite-query entry's data object as a DRAFT overlay whose
 * projected keys are the FIELDS of that object. `set(field, v)` stages a draft;
 * `commit()` promotes every staged field into the cache as a SINGLE
 * `setQueryData(key, prev => merge(prev, overlays))` write (`commit(field)` writes
 * one). When `opts.data` is supplied, reads track the cache and an auto-reconcile
 * drops drafts the authoritative record catches up to while leaving conflicts
 * masked. The query client is consumed structurally, so there is no hard
 * dependency on lite-query. The returned handle's `dispose()` also stops the
 * reconcile effect.
 */
export function projectQuery<V extends object = Record<PropertyKey, unknown>>(
    qc: QueryClientLike,
    key: unknown,
    opts?: ProjectQueryOptions<V>,
): Projection<keyof V, unknown>;

/**
 * The subset of a @zakkster/lite-crdt LWW-Map (`doc.map(name)`) that
 * {@link projectCRDT} consumes. `get(key)` must be a FINE-GRAINED reactive read
 * (re-runs only when that key's cell changes); `set(key, value)` emits a CRDT op.
 * Keys are string-coerced by lite-crdt.
 */
export interface LWWMapLike {
    /** Fine-grained reactive read: tracks the cell backing `key`. */
    get(key: string): unknown;
    /** Write the cell for `key` (emits a CRDT op). */
    set(key: string, value: unknown): void;
    /** Optional authoritative delete (emits a tombstone op). */
    delete?(key: string): void;
}

/** Options for {@link projectCRDT}. Extends the injectable clock for overlay TTL. */
export interface ProjectCRDTOptions extends Partial<ProjectionClock> {
    /** Reconciliation policy for auto-reconcile; defaults to {@link confirmOnEcho}. */
    policy?: ReconcilePolicy<string, unknown>;
    /**
     * Optional transact hook (e.g. `doc.transact`) that wraps `commit` and
     * `commitWhere` so an N-key burst coalesces into ONE ops frame + one change.
     * A supplied-but-non-function value throws before any node is created.
     */
    transact?: <T>(fn: () => T) => T;
}

/**
 * Project a @zakkster/lite-crdt LWW-Map (`doc.map(name)`) as a per-key DRAFT
 * overlay. Inherits the map's fine-grained granularity, so overlaying or
 * committing one cell never re-runs a consumer of another. `set` stages a local
 * draft, `commit(key?)` promotes drafts via `map.set` (one op per key; pass
 * `opts.transact` to coalesce a burst into one frame), and an auto-reconcile drops
 * drafts the authoritative cell catches up to while leaving conflicts (and
 * concurrent authoritative deletes) masked.
 *
 * TWO recorded hazards: (1) lite-crdt's `get` returns a deep READ-ONLY WRAPPER for
 * object values, so `confirmOnEcho` (Object.is) never auto-confirms an object
 * draft -- use a `{ ttl }` draft or a structural policy, and never mutate the
 * authoritative value a policy is handed. (2) Keys are string-coerced, so drafts
 * on `5` and `"5"` are two slots committing into one cell (last write wins).
 * Consumed structurally (no hard dependency on lite-crdt) and never touches the
 * doc or `map.store`. Dispose the projection BEFORE the doc. The returned handle's
 * `dispose()` also stops the reconcile effect.
 */
export function projectCRDT(
    map: LWWMapLike,
    opts?: ProjectCRDTOptions,
): Projection<string, unknown>;
