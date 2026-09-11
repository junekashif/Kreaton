/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic component of the system, from corpus generation to the
 * Monte Carlo recoverability estimator to the adversarial simulations, draws
 * from an explicitly seeded generator. Nothing calls Math.random. This is what
 * makes a replay reproducible, and a reproducible replay is what makes the
 * audit trail and the published metrics verifiable by a third party.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === 'string' ? Rng.hashSeed(seed) : seed >>> 0;
    // Discard the first few draws, which are weakly correlated with the seed.
    for (let i = 0; i < 4; i++) this.next();
  }

  /** Derive a 32-bit seed from a string, so seeds can be human-readable. */
  static hashSeed(s: string): number {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  /** mulberry32. Fast, 32-bit state, passes the usual smoke tests. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [lo, hi). */
  uniform(lo = 0, hi = 1): number {
    return lo + (hi - lo) * this.next();
  }

  /** Uniform integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return Math.floor(this.uniform(lo, hi + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Standard normal via the Box-Muller transform. */
  normal(mu = 0, sigma = 1): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Lognormal with the given log-space parameters. */
  lognormal(mu: number, sigma: number): number {
    return Math.exp(this.normal(mu, sigma));
  }

  /** Exponential with the given mean. */
  exponential(mean: number): number {
    let u = 0;
    while (u === 0) u = this.next();
    return -mean * Math.log(u);
  }

  /** Poisson by Knuth multiplication, adequate for the small rates used here. */
  poisson(lambda: number): number {
    const l = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > l);
    return k - 1;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called on an empty array');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Draw an index according to the supplied weights, which need not sum to 1. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Draw a key from a weighted map. */
  weightedPick<K extends string>(weights: Record<K, number>): K {
    const keys = Object.keys(weights) as K[];
    const values = keys.map((k) => weights[k]);
    return keys[this.weightedIndex(values)]!;
  }

  /** Fisher-Yates, returning a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }

  /** Sample n items without replacement. */
  sample<T>(items: readonly T[], n: number): T[] {
    return this.shuffle(items).slice(0, Math.min(n, items.length));
  }

  /**
   * Derive an independent child generator. Used so that adding a new stochastic
   * component to the pipeline does not shift the draws of every existing one,
   * which would silently invalidate committed golden fixtures.
   */
  fork(label: string): Rng {
    return new Rng(Rng.hashSeed(`${label}:${this.state}`));
  }
}
