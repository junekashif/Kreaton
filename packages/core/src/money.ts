import type { Paise } from './types.js';

/**
 * Currency handling.
 *
 * All value-bearing arithmetic in the engine is performed on integer paise.
 * Rupee floats appear only at the presentation boundary, in this module.
 */

export const PAISE_PER_RUPEE = 100;

/** Convert rupees to integer paise, rounding half away from zero. */
export function toPaise(rupees: number): Paise {
  return Math.round(rupees * PAISE_PER_RUPEE);
}

/** Convert paise to a rupee float. Presentation only. */
export function toRupees(p: Paise): number {
  return p / PAISE_PER_RUPEE;
}

/**
 * Group an integer string with the Indian numbering system: the last three
 * digits form one group, and every group above that is two digits.
 * 12345678 becomes 1,23,45,678.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${last3}`;
}

export interface FormatOptions {
  /** Include the rupee symbol. Default true. */
  symbol?: boolean;
  /** Include paise. Default false, since UPI amounts are usually whole rupees. */
  paise?: boolean;
}

/** Format paise as an Indian-grouped rupee string, e.g. INR 1,23,456. */
export function formatINR(p: Paise, opts: FormatOptions = {}): string {
  const { symbol = true, paise = false } = opts;
  const negative = p < 0;
  const abs = Math.abs(Math.round(p));
  const whole = Math.floor(abs / PAISE_PER_RUPEE);
  const frac = abs % PAISE_PER_RUPEE;
  let out = groupIndian(String(whole));
  if (paise) out += `.${String(frac).padStart(2, '0')}`;
  if (symbol) out = `₹${out}`;
  return negative ? `-${out}` : out;
}

/**
 * Compact Indian format using lakh and crore, which is how Indian payment
 * volumes are actually reported. 25000000 paise becomes 2.5 L.
 */
export function formatINRCompact(p: Paise): string {
  const negative = p < 0;
  const rupees = Math.abs(p) / PAISE_PER_RUPEE;
  let out: string;
  if (rupees >= 1e7) out = `${trimZeros(rupees / 1e7)} Cr`;
  else if (rupees >= 1e5) out = `${trimZeros(rupees / 1e5)} L`;
  else if (rupees >= 1e3) out = `${trimZeros(rupees / 1e3)} K`;
  else out = groupIndian(String(Math.round(rupees)));
  return `${negative ? '-' : ''}₹${out}`;
}

function trimZeros(n: number): string {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Regulatory and behavioural amount thresholds that matter for structuring
 * detection. Values are in paise.
 *
 * The 50,000 rupee mark is the long-standing reporting and scrutiny threshold
 * in Indian banking, and the 2,000 rupee mark is the value above which the
 * proposed first-time-beneficiary cooling period applies. Fraudsters coach
 * victims to stay just below whichever limit they believe is monitored, which
 * is exactly what the structuring signal looks for.
 */
export const AMOUNT_THRESHOLDS: readonly Paise[] = [
  toPaise(2_000),
  toPaise(25_000),
  toPaise(50_000),
  toPaise(100_000),
  toPaise(200_000),
] as const;

/**
 * Distance below the nearest threshold, as a fraction of that threshold.
 * Returns 1 when the amount is not below any threshold. Values near 0 mean the
 * amount is suspiciously close to, but under, a monitored limit.
 */
export function thresholdProximity(amount: Paise): number {
  let best = 1;
  for (const t of AMOUNT_THRESHOLDS) {
    if (amount < t) {
      const gap = (t - amount) / t;
      if (gap < best) best = gap;
    }
  }
  return best;
}
