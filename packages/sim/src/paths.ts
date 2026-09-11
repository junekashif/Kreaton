import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Repository paths and artefact writing.
 *
 * Resolved from this file rather than from the working directory, so the
 * scripts behave identically whether they are run from the repository root, from
 * the package directory, or from a continuous integration job.
 */

/** packages/sim/src -> repository root. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
export const DATA_DIR = resolve(REPO_ROOT, 'data');
export const DOCS_DIR = resolve(REPO_ROOT, 'docs');
export const WEB_PUBLIC_DIR = resolve(REPO_ROOT, 'apps', 'web', 'public', 'data');

export const ARTEFACTS = {
  model: resolve(DATA_DIR, 'model.json'),
  /** Fit diagnostics from the seed run: weights, correlations, single-signal AUCs. */
  fit: resolve(DATA_DIR, 'fit.json'),
  /** Held-out evaluation, recoverability and portfolio figures from the evaluate run. */
  metrics: resolve(DATA_DIR, 'metrics.json'),
  demoSlice: resolve(DATA_DIR, 'demo-slice.json'),
  /**
   * Trimmed slice served to the browser.
   *
   * The console runs the engine client-side so the live feed does not depend on
   * a network round trip per payment, which means the slice is downloaded
   * rather than bundled. The full slice is several megabytes and would make the
   * first paint unacceptable, so what ships is a shorter window with the fields
   * the console actually reads.
   */
  webSlice: resolve(WEB_PUBLIC_DIR, 'slice.json'),
  webModel: resolve(WEB_PUBLIC_DIR, 'model.json'),
  adversarial: resolve(DATA_DIR, 'adversarial.json'),
  portfolio: resolve(DATA_DIR, 'portfolio.json'),
  modelCard: resolve(DOCS_DIR, 'MODEL_CARD.md'),
} as const;

export function writeJson(path: string, value: unknown, pretty = true): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value), 'utf8');
}

export function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`, 'utf8');
}

/** Human-readable byte size, for the script output. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
