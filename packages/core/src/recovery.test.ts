import { describe, expect, it } from 'vitest';
import {
  CURVE_SAMPLE_MINUTES,
  DEFAULT_RECOVERY_PARAMS,
  RecoveryModel,
  buildGenerator,
  recoverableCtmc,
  simulateChains,
  splitRecoverable,
} from './recovery.js';
import { expm, identity } from './mathx.js';

describe('matrix exponential', () => {
  it('returns the identity for a zero matrix', () => {
    expect(expm([[0, 0], [0, 0]])).toEqual(identity(2));
  });

  it('matches the scalar exponential for a 1x1 matrix', () => {
    expect(expm([[1.7]])[0]![0]!).toBeCloseTo(Math.exp(1.7), 10);
    // Large magnitude exercises the scaling-and-squaring path.
    expect(expm([[-12]])[0]![0]!).toBeCloseTo(Math.exp(-12), 10);
  });

  it('matches the analytic solution for a 2x2 two-state decay', () => {
    // Q = [[-r, r], [0, 0]] gives P(t) = [[e^-rt, 1-e^-rt], [0, 1]].
    const r = 0.3;
    const p = expm([[-r, r], [0, 0]]);
    expect(p[0]![0]!).toBeCloseTo(Math.exp(-r), 10);
    expect(p[0]![1]!).toBeCloseTo(1 - Math.exp(-r), 10);
    expect(p[1]![1]!).toBeCloseTo(1, 10);
  });
});

describe('CTMC generator', () => {
  const q = buildGenerator(DEFAULT_RECOVERY_PARAMS);

  it('has one state per layer plus an absorbing cashed-out state', () => {
    expect(q.length).toBe(DEFAULT_RECOVERY_PARAMS.maxLayers + 1);
  });

  it('has rows summing to zero, as any valid generator must', () => {
    for (const row of q) {
      expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 12);
    }
  });

  it('makes the cashed-out state absorbing', () => {
    const last = q[q.length - 1]!;
    expect(last.every((v) => v === 0)).toBe(true);
  });

  it('terminates the chain at the final layer', () => {
    // The last modelled layer must send all of its outflow to cash-out.
    const k = DEFAULT_RECOVERY_PARAMS.maxLayers;
    const lastLayer = q[k - 1]!;
    expect(lastLayer[k]).toBeCloseTo(-lastLayer[k - 1]!, 12);
  });
});

describe('recoverable fraction', () => {
  it('starts at layer-one traceability and decays monotonically', () => {
    // Not 1: even funds sitting in the first mule account are not certain to be
    // reached, which is what traceabilityByLayer[0] encodes.
    expect(recoverableCtmc(DEFAULT_RECOVERY_PARAMS, 0)).toBeCloseTo(
      DEFAULT_RECOVERY_PARAMS.traceabilityByLayer[0]!,
      10,
    );
    let previous = 1;
    for (const m of CURVE_SAMPLE_MINUTES) {
      const r = recoverableCtmc(DEFAULT_RECOVERY_PARAMS, m);
      expect(r).toBeLessThanOrEqual(previous + 1e-12);
      expect(r).toBeGreaterThanOrEqual(0);
      previous = r;
    }
  });

  it('approaches zero over a long horizon', () => {
    expect(recoverableCtmc(DEFAULT_RECOVERY_PARAMS, 60 * 24 * 30)).toBeLessThan(0.001);
  });

  it('recovers more when the chain dwells longer', () => {
    const slow = { ...DEFAULT_RECOVERY_PARAMS, layerDwellMinutes: [80, 220, 470, 950, 1800, 3600] };
    expect(recoverableCtmc(slow, 60)).toBeGreaterThan(
      recoverableCtmc(DEFAULT_RECOVERY_PARAMS, 60),
    );
  });
});

describe('Monte Carlo simulation', () => {
  it('is reproducible for a fixed seed', () => {
    const a = simulateChains(DEFAULT_RECOVERY_PARAMS, 2000, 'fixed');
    const b = simulateChains(DEFAULT_RECOVERY_PARAMS, 2000, 'fixed');
    expect(a.cashOutTimes).toEqual(b.cashOutTimes);
    expect(a.expectedHops).toBe(b.expectedHops);
  });

  it('differs for a different seed', () => {
    const a = simulateChains(DEFAULT_RECOVERY_PARAMS, 2000, 'one');
    const b = simulateChains(DEFAULT_RECOVERY_PARAMS, 2000, 'two');
    expect(a.cashOutTimes).not.toEqual(b.cashOutTimes);
  });

  it('produces a hop count consistent with the configured hop probabilities', () => {
    const mc = simulateChains(DEFAULT_RECOVERY_PARAMS, 20_000, 'hops');
    // Expected hops = h0 + h0*h1 + h0*h1*h2 + ... for the configured chain.
    const h = DEFAULT_RECOVERY_PARAMS.hopProbability;
    let cumulative = 1;
    let expected = 0;
    for (let i = 0; i < DEFAULT_RECOVERY_PARAMS.maxLayers - 1; i++) {
      cumulative *= h[i] ?? 0;
      expected += cumulative;
    }
    expect(mc.expectedHops).toBeCloseTo(expected, 1);
  });

  it('touches more accounts than hops, because each hop fans out', () => {
    const mc = simulateChains(DEFAULT_RECOVERY_PARAMS, 5000, 'fanout');
    expect(mc.expectedAccounts).toBeGreaterThan(mc.expectedHops);
  });
});

describe('RecoveryModel', () => {
  const model = new RecoveryModel({ seed: 'test', paths: 20_000 });

  it('produces a monotonically decreasing curve starting at layer-one traceability', () => {
    const curve = model.estimate(60).curve;
    expect(curve[0]!.recoverable).toBeCloseTo(
      DEFAULT_RECOVERY_PARAMS.traceabilityByLayer[0]!,
      2,
    );
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.recoverable).toBeLessThanOrEqual(curve[i - 1]!.recoverable + 1e-12);
    }
  });

  it('reports a narrow sampling interval that brackets the point estimate', () => {
    const e = model.estimate(60);
    expect(e.interval).toBeDefined();
    expect(e.interval!.lo).toBeLessThanOrEqual(e.fractionAtHorizon);
    expect(e.interval!.hi).toBeGreaterThanOrEqual(e.fractionAtHorizon);
    expect(e.interval!.hi - e.interval!.lo).toBeLessThan(0.02);
  });

  it('recovers less once operational freeze latency is applied', () => {
    const instant = new RecoveryModel({ seed: 'test', paths: 20_000, freezeLatencyMinutes: 0 });
    const delayed = new RecoveryModel({ seed: 'test', paths: 20_000, freezeLatencyMinutes: 45 });
    expect(delayed.recoverableAt(10)).toBeLessThan(instant.recoverableAt(10));
  });

  it('keeps the two estimators within a documented tolerance', () => {
    // They model different dwell distributions, so they must not be identical,
    // but a large gap would mean the closed form is not a usable cross-check.
    const gap = model.estimatorGap();
    expect(gap.maxAbsDiff).toBeGreaterThan(0);
    expect(gap.maxAbsDiff).toBeLessThan(0.25);
  });

  it('reflects the golden hour: recoverability collapses within the first hour', () => {
    // The doctrine behind India 1930 helpline golden hour is that a freeze order
    // raised immediately still reaches most of the value, and one raised hours
    // later reaches very little. Both ends of that must hold.
    expect(model.recoverableAt(0)).toBeGreaterThan(0.9);
    expect(model.recoverableAt(60)).toBeLessThan(0.5);
    expect(model.recoverableAt(1440)).toBeLessThan(0.05);
  });

  it('separates the cash-out effect from the depth effect', () => {
    // Raw survival must always exceed traceability-weighted recovery: funds can
    // be uncashed yet effectively out of reach deep in the chain.
    for (const m of [10, 60, 240, 720]) {
      expect(model.recoverableAt(m)).toBeLessThan(model.survivingAt(m));
    }
  });
});

describe('splitRecoverable', () => {
  it('conserves value exactly in integer paise', () => {
    for (const amount of [1, 7, 999, 123_456_789]) {
      for (const f of [0, 0.333, 0.5, 0.6667, 1]) {
        const { recoverablePaise, lostPaise } = splitRecoverable(amount, f);
        expect(recoverablePaise + lostPaise).toBe(amount);
        expect(Number.isInteger(recoverablePaise)).toBe(true);
        expect(Number.isInteger(lostPaise)).toBe(true);
      }
    }
  });
});
