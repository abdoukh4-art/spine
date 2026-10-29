/**
 * Mulberry32: a tiny, fast, seeded pseudo-random generator (public domain, by Tommy Ettinger).
 * Not for cryptography. It's here so that "10 % of calls fail" yields the **same** calls
 * failing on every run with the same seed, which makes fault-injection tests and demos
 * reproducible.
 *
 * @returns a function producing uniform numbers in [0, 1).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
