// Type declarations for @zakkster/lite-project v1.0.0
// Zero-GC projections for @zakkster/lite-signal.
// (c) 2026 Zahary Shinikchiev <shinikchiev@yahoo.com> -- MIT

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
 * A projection handle: a granular, derived, non-mutating draft overlay over a
 * keyed source. Each touched key owns one overlay signal + one projected
 * computed, created lazily and recycled by {@link Projection.dispose}.
 */
export interface Projection<K extends PropertyKey = PropertyKey, V = unknown> {
    /** Reactive: the overlay value if one is staged for `key`, else the source value. */
    get(key: K): V;
    /** Stage an EPHEMERAL overlay for `key`. The source is NOT mutated. */
    set(key: K, value: V): void;
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
     * Full-snapshot reconciliation: drop every overlay the policy considers
     * confirmed against the current (untracked) source value. Presentation-only --
     * the source owns the real write.
     */
    reconcileAll(policy?: ReconcilePolicy<K, V>): void;
    /** Write staged overlays into the source, then clear them. With `key`, commits just that key. */
    commit(key?: K): void;
    /** Drop all overlays. */
    revert(): void;
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
}

/** The registry-bound projection primitives returned by {@link createProjector}. */
export interface Projector {
    project<K extends PropertyKey = PropertyKey, V = unknown>(
        source: ProjectionSource<K, V>,
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

/** Options for {@link projectRoom}. */
export interface ProjectRoomOptions {
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
