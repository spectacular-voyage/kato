/**
 * Sealed events: conversation events owned by the in-memory snapshot store.
 *
 * A sealed event is a deep-frozen private copy, so snapshots can share it
 * across `get()`/`upsert()` calls instead of deep-cloning every event on every
 * update, and values derived from it (byte size, merge/runtime signatures) can
 * be memoized per object. Mutating a sealed event throws a `TypeError`.
 */
const sealedEvents = new WeakSet<object>();

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
}

export function isSealedEvent(event: object): boolean {
  return sealedEvents.has(event);
}

/** Returns `event` if already sealed, otherwise a sealed deep copy of it. */
export function sealEvent<T extends object>(event: T): T {
  if (sealedEvents.has(event)) {
    return event;
  }
  const sealed = structuredClone(event);
  deepFreeze(sealed);
  sealedEvents.add(sealed);
  return sealed;
}

/**
 * Computes a value derived from an event, memoized in `cache` when the event
 * is sealed (unsealed events may still change, so they are never cached).
 */
export function memoizeForSealedEvent<K extends object, V>(
  cache: WeakMap<K, V>,
  event: K,
  compute: (event: K) => V,
): V {
  if (!sealedEvents.has(event)) {
    return compute(event);
  }
  const cached = cache.get(event);
  if (cached !== undefined) {
    return cached;
  }
  const value = compute(event);
  cache.set(event, value);
  return value;
}
