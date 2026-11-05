/**
 * Deterministic, valid UUIDv7-shaped IDs for fixtures: `0192f0a0-<kind>-7000-8000-<n>`.
 * The version nibble (7) and variant nibble (8) make them pass `z.uuid()`.
 */
export function fakeId(kind: number, n: number): string {
  const k = kind.toString(16).padStart(4, '0');
  const tail = n.toString(16).padStart(12, '0');
  return `0192f0a0-${k}-7000-8000-${tail}`;
}

/** ID namespaces, so an alert and a run with the same `n` never collide. */
export const ID_KIND = {
  user: 1,
  alert: 2,
  run: 3,
  approval: 4,
  action: 5,
  audit: 6,
} as const;

/**
 * A small seeded PRNG (mulberry32): the same seed always yields the same "random"
 * background alerts, so screenshots and tests are reproducible.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
