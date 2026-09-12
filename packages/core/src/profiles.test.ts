import { describe, expect, it } from 'vitest';
import { BALANCE_PROXY_MULTIPLE, emptyPayerProfile, updatePayerProfile } from './profiles.js';
import { EXTRACTORS } from './signals/extract.js';
import { emptyPayeeProfile } from './profiles.js';
import type { Millis, Paise, PayerProfile, ScoringContext, Transaction } from './types.js';

/**
 * The drain-ratio signal divides the payment by what the payer had available.
 *
 * Normally that figure is an estimate inferred from spending history, because
 * a sending institution scoring its own customer usually cannot read the
 * balance at authorisation time. When it can — an on-us payment, or an
 * imported statement carrying a running balance — the observed figure is
 * strictly better, and these tests pin the behaviour both ways.
 */

const TS = Date.UTC(2026, 3, 1, 10, 0) as Millis;

function payment(amountPaise: number, ts: Millis = TS): Transaction {
  return {
    txnId: `t_${ts}_${amountPaise}`,
    ts,
    payerId: 'p1',
    payerVpa: 'p1@bank',
    payeeId: 'e1',
    payeeVpa: 'e1@bank',
    payeeName: 'A PAYEE',
    amountPaise: amountPaise as Paise,
    channel: 'p2p',
    deviceId: 'dev1',
    ipHash: 'ip',
    simSerialHash: 'sim',
    context: {
      activeCall: false,
      activeCallSeconds: 0,
      screenShareActive: false,
      remoteAccessAppRunning: false,
      appSwitchCount: 0,
      secondsFromOpenToAuthorize: 30,
      vpaEnteredBy: 'typed',
      beneficiaryAddedAtMs: null,
      sessionId: 's1',
      isNewDevice: false,
      deviceBoundAtMs: (TS - 400 * 86_400_000) as Millis,
      simChangedRecently: false,
    },
  };
}

function context(payer: PayerProfile): ScoringContext {
  return {
    payer,
    payee: emptyPayeeProfile('e1', 'e1@bank', TS),
    recentPayerTxns: [],
    openHolds: [],
  } as unknown as ScoringContext;
}

/** A payer with a settled history of ordinary payments. */
function seasonedPayer(): PayerProfile {
  let profile = emptyPayerProfile('p1', (TS - 30 * 86_400_000) as Millis);
  for (let i = 0; i < 30; i++) {
    profile = updatePayerProfile(profile, payment(100_000, (TS - (30 - i) * 86_400_000) as Millis));
  }
  return profile;
}

describe('the balance the drain-ratio signal divides by', () => {
  it('is estimated from spending history when nothing better is available', () => {
    const profile = seasonedPayer();
    expect(profile.observedBalancePaise).toBeUndefined();
    expect(profile.balanceProxyPaise).toBe(profile.dailyValueMean * BALANCE_PROXY_MULTIPLE);

    const signal = EXTRACTORS.DRAIN_RATIO!(payment(50_000), context(profile));
    expect(signal.raw).toBeCloseTo(50_000 / profile.balanceProxyPaise, 10);
    expect(signal.evidence).toMatch(/inferred from spending history/);
  });

  it('is the observed figure when the institution has one', () => {
    const profile: PayerProfile = { ...seasonedPayer(), observedBalancePaise: 200_000 as Paise };
    const signal = EXTRACTORS.DRAIN_RATIO!(payment(150_000), context(profile));

    expect(signal.raw).toBeCloseTo(0.75, 10);
    expect(signal.evidence).toMatch(/an observed balance/);
    expect(signal.evidence).not.toMatch(/inferred/);
  });

  it('survives the profile update, so a per-payment figure is not overwritten', () => {
    const profile: PayerProfile = { ...seasonedPayer(), observedBalancePaise: 200_000 as Paise };
    const after = updatePayerProfile(profile, payment(150_000));

    expect(after.observedBalancePaise).toBe(200_000);
    // Without the observed figure the estimate would have been far larger.
    expect(after.balanceProxyPaise).toBe(200_000);
  });

  it('falls back to the estimate when the observed figure is zero or absent', () => {
    // A drained account reporting a zero balance must not divide by zero, and
    // must not silently claim to be a measurement either.
    const zeroed: PayerProfile = { ...seasonedPayer(), observedBalancePaise: 0 as Paise };
    const after = updatePayerProfile(zeroed, payment(150_000));
    expect(after.balanceProxyPaise).toBeGreaterThan(0);

    const signal = EXTRACTORS.DRAIN_RATIO!(payment(150_000), context(zeroed));
    expect(Number.isFinite(signal.raw)).toBe(true);
    expect(signal.evidence).toMatch(/inferred from spending history/);
  });

  it('reports a full drain as a ratio of one, not something above it', () => {
    const profile: PayerProfile = { ...seasonedPayer(), observedBalancePaise: 89_000 as Paise };
    const signal = EXTRACTORS.DRAIN_RATIO!(payment(89_000), context(profile));
    expect(signal.raw).toBeCloseTo(1, 10);
  });
});
