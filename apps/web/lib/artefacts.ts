import type { ModelSpec, Policy, SignalGroup, SignalId } from '@kreaton/core';
import type { DefenceId, DefencePerformance, FullMetrics, PortfolioReport } from '@kreaton/sim';
import adversarialJson from '../../../data/adversarial.json';
import adversarialLiabilityFirstJson from '../../../data/adversarial-liability_first.json';
import fitJson from '../../../data/fit.json';
import metricsJson from '../../../data/metrics.json';
import modelJson from '../../../data/model.json';
import portfolioJson from '../../../data/portfolio.json';

/**
 * Committed artefacts, bundled at build time.
 *
 * These are the outputs of `npm run seed`, `npm run evaluate` and
 * `npm run adversarial`, reproduced byte for byte from the seed. The pages that
 * read them are static: nothing here changes between requests, and a report
 * that quietly recomputed itself on every visit would not be a report.
 */

export interface FitArtefact {
  generatedAt: string;
  modelVersion: string;
  corpus: {
    totalTransactions: number;
    fraudulentTransactions: number;
    observedFraudRate: number;
    totalValuePaise: number;
    fraudValuePaise: number;
    byTypology: Record<string, { count: number; valuePaise: number }>;
  };
  split: { splitAtMs: number; trainRows: number; testRows: number };
  diagnostics: {
    groupCorrelation: Record<SignalGroup, number>;
    weights: Record<SignalId, number>;
    irlsIterations: number;
    irlsConverged: boolean;
    trainRows: number;
    trainFraud: number;
    filledBins: Array<{ signal: SignalId; bin: number }>;
    marginalAuc: Record<SignalId, number>;
  };
  metrics: ModelSpec['metrics'];
}

export interface MetricsArtefact {
  generatedAt: string;
  modelVersion: string;
  corpus: FitArtefact['corpus'];
  split: FitArtefact['split'];
  heldOut: FullMetrics;
  recovery: {
    atReportLag: number;
    quantiles: { p10: number; p50: number; p90: number };
    estimatorGap: { maxAbsDiff: number; atMinutes: number };
    curve: Array<{ minutes: number; recoverable: number }>;
  };
  portfolio: PortfolioReport;
  auditChainValid: boolean;
}

export interface AdversarialArtefact {
  generatedAt: string;
  modelVersion: string;
  episodesPerAttack: number;
  policyPreset: { id: string; label: string };
  policy: Policy;
  defences: Record<DefenceId, { label: string; description: string; falsePositiveRate: number }>;
  calibration: {
    referenceFpr: number;
    params: { ruleHighAmount: number; ruleNewPayeeAmount: number; ruleNoveltyHours: number; fixedThreshold: number };
    legitimateSampleSize: number;
  };
  results: Array<{
    id: string;
    label: string;
    description: string;
    premise: string;
    countermeasure: string;
    removedForComparison: string[];
    episodes: number;
    byDefence: Record<DefenceId, DefencePerformance>;
    ablation: {
      caughtHardened: number;
      caughtAblated: number;
      hardenedRate: number;
      ablatedRate: number;
      improvementPp: number;
      significant: boolean;
      valueLeakedHardenedPaise: number;
      valueLeakedAblatedPaise: number;
    };
  }>;
  summary: Record<DefenceId, { caught: number; episodes: number; leaked: number }>;
}

export const MODEL = modelJson as unknown as ModelSpec;
export const FIT = fitJson as unknown as FitArtefact;
export const METRICS = metricsJson as unknown as MetricsArtefact;
export const PORTFOLIO = portfolioJson as unknown as PortfolioReport;
export const ADVERSARIAL = adversarialJson as unknown as AdversarialArtefact;
/** The same suite under the liability-first preset, for the stance comparison. */
export const ADVERSARIAL_LIABILITY_FIRST = adversarialLiabilityFirstJson as unknown as AdversarialArtefact;

export const DEFENCE_ORDER: DefenceId[] = ['rule_baseline', 'fixed_threshold', 'expected_cost'];

export const TYPOLOGY_LABEL: Record<string, string> = {
  digital_arrest: 'Digital arrest',
  kyc_update: 'KYC update',
  investment_trading: 'Investment and trading',
  job_task: 'Job and task',
  refund_reversal: 'Refund reversal',
  romance: 'Romance',
  purchase_marketplace: 'Marketplace purchase',
  impersonation_known_person: 'Impersonation of a known person',
  unknown: 'Unknown',
};
