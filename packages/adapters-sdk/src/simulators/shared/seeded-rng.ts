/**
 * Deterministic PRNG for simulator scenarios (repo convention: every scenario
 * and fault profile is driven by an explicit integer seed — no wall clock, no
 * unseeded randomness). mulberry32: small, fast, and reproducible across
 * engines, so a fixed seed replays the identical event trace everywhere.
 */
export interface SeededRng {
  readonly seed: number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  intBelow(maxExclusive: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly NonNullable<T>[]): NonNullable<T>;
}

export function createSeededRng(seed: number): SeededRng {
  if (!Number.isInteger(seed)) {
    throw new RangeError(`scenario seed must be an integer, got ${seed}`);
  }
  let state = seed >>> 0; // mulberry32 state is a uint32; negative seeds fold in
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    intBelow(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
        throw new RangeError(`intBelow() requires an integer >= 1, got ${maxExclusive}`);
      }
      return Math.floor(next() * maxExclusive);
    },
    chance(p: number): boolean {
      if (p < 0 || p > 1) {
        throw new RangeError(`chance() requires p in [0, 1], got ${p}`);
      }
      return next() < p;
    },
    pick<T>(items: readonly NonNullable<T>[]): NonNullable<T> {
      const item = items[this.intBelow(items.length)];
      if (item === undefined) {
        throw new RangeError("pick() requires a non-empty array");
      }
      return item;
    },
  };
}
