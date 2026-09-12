/**
 * Binding a file's columns to the engine's fields.
 *
 * Auto-detection is a convenience, never an authority: it proposes a mapping
 * from the header row and the operator confirms or overrides every line of it
 * before anything is scored. Getting the payer column wrong would silently
 * rebuild every behavioural baseline against the wrong identity, and that is
 * not a failure a progress bar should hide.
 */

import { FIELDS, FIELDS_BY_PATH } from './fields.js';
import type { FieldSpec } from './fields.js';
import type { AmountUnit, TimestampMode } from './coerce.js';

export interface ColumnBinding {
  /** Header in the source file. Null means the field is not supplied. */
  column: string | null;
  /** Applied to every row instead of reading a column. */
  constant?: string;
  /** Amount fields only. */
  unit?: AmountUnit;
  /** Timestamp fields only. */
  mode?: TimestampMode;
}

/** Keyed by field path. Absent keys mean the field is not supplied. */
export type Mapping = Record<string, ColumnBinding>;

export interface MappingPreset {
  id: string;
  label: string;
  /** One line naming the shape of file this fits. */
  describes: string;
  /** Field path to source header. Headers are matched case-insensitively. */
  columns: Record<string, string>;
  units?: Record<string, AmountUnit>;
  modes?: Record<string, TimestampMode>;
  /** Literal values applied to every row. */
  constants?: Record<string, string>;
}

/**
 * Named layouts worth recognising outright.
 *
 * A preset is offered when its required columns are all present in the header.
 * It is a starting point for the mapping panel, not a bypass of it.
 */
export const PRESETS: readonly MappingPreset[] = [
  {
    id: 'kreaton',
    label: 'Kreaton export',
    describes: 'A file this console produced, or one written to the engine transaction shape.',
    columns: {
      txnId: 'txnId',
      ts: 'ts',
      payerId: 'payerId',
      payerVpa: 'payerVpa',
      payeeId: 'payeeId',
      payeeVpa: 'payeeVpa',
      payeeName: 'payeeName',
      amountPaise: 'amountPaise',
      channel: 'channel',
      deviceId: 'deviceId',
      'context.activeCall': 'activeCall',
      'context.activeCallSeconds': 'activeCallSeconds',
      'context.screenShareActive': 'screenShareActive',
      'context.remoteAccessAppRunning': 'remoteAccessAppRunning',
      'context.appSwitchCount': 'appSwitchCount',
      'context.secondsFromOpenToAuthorize': 'secondsFromOpenToAuthorize',
      'context.vpaEnteredBy': 'vpaEnteredBy',
      'context.isNewDevice': 'isNewDevice',
      'context.simChangedRecently': 'simChangedRecently',
      'label.isFraud': 'isFraud',
      'label.typology': 'typology',
    },
    units: { amountPaise: 'paise' },
    modes: { ts: 'epoch_ms' },
  },
  {
    id: 'paysim',
    label: 'PaySim',
    describes: 'The Kaggle mobile-money simulation (ealaxi/paysim1). Carries amounts and labels but no session context.',
    columns: {
      ts: 'step',
      direction: 'type',
      amountPaise: 'amount',
      payerId: 'nameOrig',
      payeeId: 'nameDest',
      balancePaise: 'newbalanceOrig',
      'label.isFraud': 'isFraud',
    },
    units: { amountPaise: 'rupees', balancePaise: 'rupees' },
    modes: { ts: 'step_hours' },
  },
  {
    id: 'statement',
    label: 'Bank statement',
    describes: 'A passbook or account statement: a date, a narration, and separate debit and credit columns.',
    columns: {
      ts: 'Date',
      payeeName: 'Narration',
      amountPaise: 'Debit',
      creditPaise: 'Credit',
      balancePaise: 'Balance',
    },
    units: { amountPaise: 'rupees', creditPaise: 'rupees', balancePaise: 'rupees' },
    modes: { ts: 'day_first' },
  },
];

/** Normalise a header for comparison: lowercase, alphanumerics only. */
function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

interface Candidate {
  path: string;
  column: string;
  score: number;
}

/**
 * Score a header against one field.
 *
 * Exact beats prefix beats containment, and a longer synonym beats a shorter
 * one, so "beneficiary name" claims the name column ahead of the bare "name"
 * synonym that several other fields also carry.
 */
function scoreColumn(field: FieldSpec, header: string): number {
  const h = normalise(header);
  if (h === '') return 0;
  let best = 0;
  const targets = [field.path, field.label, ...field.synonyms];
  for (const t of targets) {
    const n = normalise(t);
    if (n === '') continue;
    let s = 0;
    if (h === n) s = 1000 + n.length;
    else if (h.startsWith(n) || n.startsWith(h)) s = 500 + n.length;
    else if (h.includes(n)) s = 200 + n.length;
    else if (n.includes(h) && h.length >= 4) s = 100 + h.length;
    if (s > best) best = s;
  }
  return best;
}

export interface DetectionResult {
  mapping: Mapping;
  /** Preset whose columns are all present, if any. */
  preset: MappingPreset | null;
  /** Headers the detector could not place. */
  unmatched: string[];
}

/**
 * Propose a mapping for a header row.
 *
 * Candidates are scored across every field and column pair, then assigned in
 * descending score, each column and each field taken at most once. That is a
 * greedy assignment rather than an optimal one, which is the right trade here:
 * a near miss is corrected in one click, and a stable, explicable result is
 * worth more than an extra percent of accuracy nobody can audit.
 */
export function detectMapping(header: readonly string[]): DetectionResult {
  const preset = PRESETS.find((p) => presetFits(p, header)) ?? null;
  if (preset) {
    return { mapping: mappingFromPreset(preset, header), preset, unmatched: [] };
  }

  const candidates: Candidate[] = [];
  for (const field of FIELDS) {
    for (const column of header) {
      const score = scoreColumn(field, column);
      if (score >= 200) candidates.push({ path: field.path, column, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const mapping: Mapping = {};
  const usedColumns = new Set<string>();
  for (const c of candidates) {
    if (mapping[c.path] || usedColumns.has(c.column)) continue;
    mapping[c.path] = withDefaults(c.path, { column: c.column });
    usedColumns.add(c.column);
  }

  // A statement with a debit column and a credit column needs the direction
  // derived from which one carries a value, not from a type column.
  if (mapping.creditPaise && !mapping.direction) delete mapping.direction;

  return {
    mapping,
    preset: null,
    unmatched: header.filter((h) => h.trim() !== '' && !usedColumns.has(h)),
  };
}

function presetFits(preset: MappingPreset, header: readonly string[]): boolean {
  const present = new Set(header.map(normalise));
  const needed = Object.values(preset.columns).map(normalise);
  const hits = needed.filter((n) => present.has(n)).length;
  // Every field the preset names for a required engine field must be there,
  // and most of the rest, before the preset is claimed.
  const requiredHit = ['payerId', 'payeeId', 'amountPaise']
    .filter((p) => preset.columns[p])
    .every((p) => present.has(normalise(preset.columns[p]!)));
  return requiredHit && hits >= Math.ceil(needed.length * 0.7);
}

function mappingFromPreset(preset: MappingPreset, header: readonly string[]): Mapping {
  const byNormal = new Map(header.map((h) => [normalise(h), h]));
  const mapping: Mapping = {};
  for (const [path, col] of Object.entries(preset.columns)) {
    const actual = byNormal.get(normalise(col));
    if (!actual) continue;
    const binding: ColumnBinding = { column: actual };
    const unit = preset.units?.[path];
    const mode = preset.modes?.[path];
    if (unit) binding.unit = unit;
    if (mode) binding.mode = mode;
    mapping[path] = withDefaults(path, binding);
  }
  for (const [path, value] of Object.entries(preset.constants ?? {})) {
    mapping[path] = { column: null, constant: value };
  }
  return mapping;
}

/**
 * Fill in the unit and mode a field needs when the caller did not state one.
 *
 * A column literally named `amountPaise` is in paise, and guessing rupees for
 * it would inflate every amount by a hundred. The inference is deliberately
 * narrow — it reads the column's own name and nothing else — because a wrong
 * guess about money is worse than asking.
 */
export function withDefaults(path: string, binding: ColumnBinding): ColumnBinding {
  const field = FIELDS_BY_PATH.get(path);
  if (!field) return binding;
  const out: ColumnBinding = { ...binding };
  if (field.kind === 'amount' && !out.unit) {
    out.unit = binding.column && /paise|paisa/i.test(binding.column) ? 'paise' : 'rupees';
  }
  if (field.kind === 'timestamp' && !out.mode) out.mode = 'auto';
  return out;
}

/** Field paths a mapping supplies, whether from a column or a constant. */
export function suppliedPaths(mapping: Mapping): Set<string> {
  const out = new Set<string>();
  for (const [path, b] of Object.entries(mapping)) {
    if (b && (b.column !== null || (b.constant !== undefined && b.constant !== ''))) out.add(path);
  }
  return out;
}

/**
 * Required fields the mapping leaves genuinely unsatisfiable.
 *
 * Two of the three required fields have a defensible substitute, so this is
 * narrower than "required and unmapped". A file with no payer column is read
 * as one account holder, which is what a bank statement is. A file with no
 * beneficiary identifier is keyed on the beneficiary name, which is what a
 * narration is. Only the amount has no substitute: a payment with no amount
 * cannot be priced, and pricing is the whole decision.
 */
export function missingRequired(mapping: Mapping): FieldSpec[] {
  const supplied = suppliedPaths(mapping);
  const out: FieldSpec[] = [];
  for (const f of FIELDS) {
    if (!f.required || supplied.has(f.path)) continue;
    if (f.path === 'payerId') continue;
    if (f.path === 'payeeId' && supplied.has('payeeName')) continue;
    out.push(f);
  }
  return out;
}
