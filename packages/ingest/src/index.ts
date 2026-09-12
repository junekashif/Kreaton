/**
 * @kreaton/ingest
 *
 * Bringing an arbitrary dataset into the interception engine: reading the
 * file, proposing a column mapping, coercing cells, constructing ordered
 * transactions and reporting honestly on what the file could not supply.
 *
 * Zero dependencies and isomorphic, like @kreaton/core, because the same code
 * runs in the browser tab where an operator drops a file, in the route handler
 * behind POST /api/v1/import, and in the command-line evaluator.
 */

export { parseDelimited, sniffDelimiter, toRecord } from './delimited.js';
export type { Delimiter, ParsedTable, ParseOptions } from './delimited.js';

export { readSource, sniffFormat } from './source.js';
export type { SourceFormat, SourceTable, ReadOptions } from './source.js';

export {
  FIELDS,
  FIELDS_BY_PATH,
  FIELD_GROUP_LABELS,
  REQUIRED_PATHS,
  QUIET_PATHS,
} from './fields.js';
export type { FieldKind, FieldGroup, FieldSpec } from './fields.js';

export {
  coerceAmount,
  coerceBoolean,
  coerceEnum,
  coerceNumber,
  coerceTimestamp,
} from './coerce.js';
export type { AmountUnit, Coerced, TimestampMode } from './coerce.js';

export {
  PRESETS,
  detectMapping,
  missingRequired,
  suppliedPaths,
  withDefaults,
} from './mapping.js';
export type { ColumnBinding, DetectionResult, Mapping, MappingPreset } from './mapping.js';

export { buildDataset, hoursBetween, rupees } from './build.js';
export type {
  BuildOptions,
  ColumnIssue,
  ImportReport,
  ImportedDataset,
  ImportedIntel,
  ImportedPayee,
} from './build.js';
