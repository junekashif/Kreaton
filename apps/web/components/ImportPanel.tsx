'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FIELDS,
  FIELD_GROUP_LABELS,
  PRESETS,
  buildDataset,
  detectMapping,
  missingRequired,
  readSource,
  withDefaults,
} from '@kreaton/ingest';
import type {
  AmountUnit,
  FieldGroup,
  FieldSpec,
  ImportedDataset,
  Mapping,
  SourceTable,
  TimestampMode,
} from '@kreaton/ingest';
import { formatINR, withCommas } from '../lib/format';
import { istDateTime } from '../lib/format';
import { useSession } from '../lib/use-session';

/**
 * Bring your own dataset.
 *
 * Three things happen here in order, and the order is the point. The file is
 * read and its columns are matched against the fields the engine can use. The
 * operator confirms that matching, because binding the wrong column to the
 * payer would rebuild every behavioural baseline against the wrong identity
 * and no downstream figure would look wrong. Only then is the file replayed,
 * and only alongside a report of everything it could not supply.
 *
 * The report is not a formality. Almost no real file carries UPI session
 * context, and a run without it puts the engine in the hardest position it
 * has — the suppressed-indicator case from the adversarial suite. A detection
 * rate measured that way is a floor, and the console says so rather than
 * letting the number stand on its own.
 */

/** Rows read for the preview and the mapping proposal. */
const PREVIEW_ROWS = 50;

/**
 * A ceiling on how many payments one browser tab will replay.
 *
 * The engine is fast enough that the arithmetic is not the constraint; the
 * feed, which keeps every decision for the assessment panel and the ledger,
 * is. A public dataset can run to millions of rows, and silently chewing
 * through one until the tab dies would be worse than reading a prefix and
 * saying so. The command-line importer has no such limit.
 */
const LARGE_FILE_ROWS = 50_000;

type Stage = 'choose' | 'map' | 'done';

interface Loaded {
  name: string;
  text: string;
  source: SourceTable;
  /**
   * Captured when the file is read, not per render.
   *
   * It anchors relative timestamps — a PaySim step number is hours from
   * somewhere — so it has to be the same instant for the preview and for the
   * replay, or the two would disagree about when the file happened.
   */
  baseMs: number;
}

const GROUP_ORDER: FieldGroup[] = ['identity', 'payment', 'session', 'device', 'beneficiary', 'label'];

const SAMPLES: Array<{ id: string; label: string; describes: string; body: string }> = [
  {
    id: 'statement',
    label: 'Bank statement',
    describes: 'A passbook export: a date, a narration, debit and credit columns and a running balance. No payer column, no beneficiary number.',
    body: [
      'Date,Narration,Debit,Credit,Balance',
      '02/04/2026,SALARY APRIL,,"88,000.00","1,04,200.00"',
      '02/04/2026,BIG BAZAAR RETAIL,"2,340.00",,"1,01,860.00"',
      '03/04/2026,RAMESH TRADERS,"1,250.00",,"1,00,610.00"',
      '05/04/2026,Ramesh Traders,"2,000.00",,"98,610.00"',
      '08/04/2026,ELECTRICITY BOARD,"3,180.00",,"95,430.00"',
      '11/04/2026,RAMESH TRADERS.,"1,700.00",,"93,730.00"',
      '14/04/2026,SWIGGY ORDER,"640.00",,"93,090.00"',
      '18/04/2026,CYBER CELL VERIFICATION,"89,000.00",,"4,090.00"',
    ].join('\n'),
  },
  {
    id: 'upi',
    label: 'UPI log with session context',
    describes: 'What a payment service provider actually sees at authorisation, including the call and entry-method fields no public dataset carries.',
    body: [
      'txn_id,timestamp,payer,payee,payee_name,amount,entry_method,on_call,call_seconds,app_switches,seconds_to_pay,new_device,onward_velocity,is_fraud',
      't1,2026-04-01T09:12:00Z,ravi.k,kirana.store,SHREE KIRANA,480,qr,false,0,1,22,false,0.05,0',
      't2,2026-04-01T19:40:00Z,ravi.k,landlord.hdfc,S IYER,18000,contact,false,0,2,31,false,0.10,0',
      't3,2026-04-03T13:05:00Z,ravi.k,kirana.store,SHREE KIRANA,610,qr,false,0,1,18,false,0.05,0',
      't4,2026-04-04T21:58:00Z,ravi.k,verify.cell,CYBER CELL VERIFICATION,185000,pasted,true,2700,7,14,false,0.94,1',
      't5,2026-04-05T10:20:00Z,meena.s,kirana.store,SHREE KIRANA,300,qr,false,0,1,25,false,0.05,0',
      't6,2026-04-05T22:10:00Z,meena.s,refund.desk,REFUND PROCESSING DESK,96000,pasted,true,1500,9,11,true,0.88,1',
    ].join('\n'),
  },
];

export function ImportPanel() {
  const router = useRouter();
  const { snap, session } = useSession();

  const [stage, setStage] = useState<Stage>('choose');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [presetId, setPresetId] = useState<string>('auto');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportedDataset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const accept = useCallback((name: string, text: string) => {
    setError(null);
    setResult(null);
    try {
      const source = readSource(text, { limit: PREVIEW_ROWS });
      if (source.header.length === 0) {
        setError('No column headings were found. The first row of the file should name the columns.');
        return;
      }
      const detected = detectMapping(source.header);
      setLoaded({ name, text, source, baseMs: Date.now() });
      setMapping(detected.mapping);
      setPresetId(detected.preset?.id ?? 'auto');
      setStage('map');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const onFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setBusy(true);
      try {
        accept(file.name, await file.text());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [accept],
  );

  const setBinding = useCallback((path: string, column: string | null) => {
    setMapping((m) => {
      const next = { ...m };
      if (column === null) delete next[path];
      else next[path] = withDefaults(path, { column });
      return next;
    });
    setPresetId('auto');
  }, []);

  const setUnit = useCallback((path: string, unit: AmountUnit) => {
    setMapping((m) => (m[path] ? { ...m, [path]: { ...m[path]!, unit } } : m));
  }, []);

  const setMode = useCallback((path: string, mode: TimestampMode) => {
    setMapping((m) => (m[path] ? { ...m, [path]: { ...m[path]!, mode } } : m));
  }, []);

  const applyPreset = useCallback(
    (id: string) => {
      setPresetId(id);
      if (!loaded) return;
      if (id === 'auto') {
        setMapping(detectMapping(loaded.source.header).mapping);
        return;
      }
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return;
      const lower = new Map(loaded.source.header.map((h) => [h.toLowerCase().replace(/[^a-z0-9]/g, ''), h]));
      const next: Mapping = {};
      for (const [path, col] of Object.entries(preset.columns)) {
        const actual = lower.get(col.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (!actual) continue;
        const binding = withDefaults(path, { column: actual });
        const unit = preset.units?.[path];
        const mode = preset.modes?.[path];
        next[path] = { ...binding, ...(unit ? { unit } : {}), ...(mode ? { mode } : {}) };
      }
      setMapping(next);
    },
    [loaded],
  );

  /** A preview built from the first rows only, so typing in the mapping is instant. */
  const preview = useMemo(() => {
    if (!loaded) return null;
    try {
      return buildDataset(loaded.source.rows, mapping, { baseMs: loaded.baseMs });
    } catch {
      return null;
    }
  }, [loaded, mapping]);

  const blocking = useMemo(() => missingRequired(mapping), [mapping]);

  const run = useCallback(() => {
    if (!loaded || blocking.length > 0) return;
    setBusy(true);
    setError(null);
    // Yield once so the button paints its busy state before the parse blocks.
    setTimeout(() => {
      try {
        const full = readSource(loaded.text);
        const dataset = buildDataset(full.rows, mapping, { baseMs: loaded.baseMs, limit: LARGE_FILE_ROWS });
        if (dataset.transactions.length === 0) {
          setError('No payments survived the mapping. The report below says which rows were dropped and why.');
          setResult(dataset);
          return;
        }
        setResult(dataset);
        session.loadImported(dataset, loaded.name);
        setStage('done');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    }, 0);
  }, [loaded, mapping, blocking, session]);

  const reset = useCallback(() => {
    setLoaded(null);
    setMapping({});
    setResult(null);
    setError(null);
    setStage('choose');
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  // --- choose -------------------------------------------------------------

  if (stage === 'choose') {
    return (
      <div className="stack">
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void onFile(e.dataTransfer.files[0]);
          }}
        >
          <p className="dz-lead">Drop a file here, or choose one.</p>
          <p className="muted small">
            CSV, TSV, semicolon or pipe delimited, or JSON. Nothing leaves your browser: the file is read and
            replayed in this tab.
          </p>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? 'Reading…' : 'Choose a file'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,.json,text/csv,text/plain,application/json"
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
          </div>
        </div>

        {error && <p className="alert">{error}</p>}

        <section className="panel">
          <header><h2>Or start from a sample</h2></header>
          <p className="muted small mb">
            Two shapes worth seeing, because they sit at opposite ends of what an import can tell you.
          </p>
          <div className="sample-row">
            {SAMPLES.map((s) => (
              <button key={s.id} type="button" className="sample" onClick={() => accept(`${s.label} (sample)`, s.body)}>
                <span className="sample-label">{s.label}</span>
                <span className="muted tiny">{s.describes}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  // --- done ---------------------------------------------------------------

  if (stage === 'done' && result) {
    return (
      <div className="stack">
        <section className="panel">
          <header><h2>Loaded</h2></header>
          <p>
            <strong>{withCommas(result.transactions.length)}</strong> payments from{' '}
            <span className="mono">{loaded?.name}</span> are now the corpus this console replays. The feed, the
            assessment panel, the ledger and the policy studio all read from it.
          </p>
          <div className="btn-row mt">
            <button type="button" className="btn primary" onClick={() => router.push('/')}>
              Watch it run
            </button>
            <button type="button" className="btn" onClick={reset}>
              Import another file
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                session.restoreShipped();
                reset();
              }}
            >
              Go back to the shipped corpus
            </button>
          </div>
        </section>
        <ReportView dataset={result} />
      </div>
    );
  }

  // --- map ----------------------------------------------------------------

  const header = loaded?.source.header ?? [];
  const used = new Set(Object.values(mapping).map((b) => b.column).filter((c): c is string => c !== null));

  return (
    <div className="stack">
      <section className="panel">
        <div className="between">
          <header><h2>{loaded?.name}
            <span className="th-sub">
              {header.length} columns · {loaded?.source.format === 'json' ? 'JSON' : `delimited with “${loaded?.source.delimiter}”`}
            </span>
          </h2></header>
          <button type="button" className="btn" onClick={reset}>
            Choose a different file
          </button>
        </div>

        <div className="field mt">
          <label className="label" htmlFor="preset">Layout</label>
          <select className="select" id="preset" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            <option value="auto">Matched from the column names</option>
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="help">
            {presetId === 'auto'
              ? 'Every row below was proposed by matching your column names. Change any of them.'
              : PRESETS.find((p) => p.id === presetId)?.describes}
          </p>
        </div>
      </section>

      {blocking.length > 0 && (
        <p className="alert">
          {blocking.map((f) => f.label).join(' and ')} {blocking.length === 1 ? 'has' : 'have'} no column. {' '}
          {blocking[0]?.help}
        </p>
      )}

      <section className="panel">
        <header><h2>Which column is which</h2></header>
        <p className="muted small mb">
          Anything left unsupplied gets the substitute named beside it. Substitutes are not neutral — the ones marked
          <span className="quiet-dot" aria-hidden /> <em>quiet</em> hand the engine the reading an attacker would want.
        </p>
        {GROUP_ORDER.map((group) => (
          <div key={group} className="map-group">
            <h3 className="map-group-head">{FIELD_GROUP_LABELS[group]}</h3>
            <div className="map-rows">
              {FIELDS.filter((f) => f.group === group).map((field) => (
                <MapRow
                  key={field.path}
                  field={field}
                  header={header}
                  used={used}
                  binding={mapping[field.path] ?? null}
                  onColumn={(c) => setBinding(field.path, c)}
                  onUnit={(u) => setUnit(field.path, u)}
                  onMode={(m) => setMode(field.path, m)}
                />
              ))}
            </div>
          </div>
        ))}
      </section>

      {preview && preview.transactions.length > 0 && (
        <section className="panel">
          <header><h2>How the first rows read
            <span className="th-sub">after the mapping above, before anything is scored</span>
          </h2></header>
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>When</th>
                  <th>Payer</th>
                  <th>Beneficiary</th>
                  <th className="num">Amount</th>
                  <th>Context</th>
                  {preview.report.labelled && <th>Known</th>}
                </tr>
              </thead>
              <tbody>
                {preview.transactions.slice(0, 8).map((t) => (
                  <tr key={t.txnId}>
                    <td className="mono tiny">{t.txnId}</td>
                    <td className="tiny">{istDateTime(t.ts)}</td>
                    <td className="tiny">{t.payerId}</td>
                    <td className="tiny">{t.payeeName}</td>
                    <td className="num mono">{formatINR(t.amountPaise)}</td>
                    <td className="tiny muted">
                      {[
                        t.context.activeCall ? `on a call ${Math.round(t.context.activeCallSeconds / 60)}m` : null,
                        t.context.vpaEnteredBy,
                        t.context.isNewDevice ? 'new device' : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </td>
                    {preview.report.labelled && (
                      <td className="tiny">{t.label.isFraud ? <span className="tag-fraud">fraud</span> : '—'}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loaded && loaded.source.rows.length >= PREVIEW_ROWS && (
            <p className="muted tiny mt">
              Read from the first {PREVIEW_ROWS} rows. The whole file is read when you replay it.
            </p>
          )}
        </section>
      )}

      {preview && <ReportView dataset={preview} preview />}

      {error && <p className="alert">{error}</p>}

      <div className="btn-row sticky-run">
        <button
          type="button"
          className="btn primary"
          onClick={run}
          disabled={busy || blocking.length > 0 || snap.status !== 'ready'}
        >
          {busy ? 'Reading the whole file…' : 'Replay this file'}
        </button>
        <span className="muted tiny">
          {snap.status !== 'ready'
            ? 'Waiting for the engine to finish loading.'
            : `The engine starts from nothing: no prior profiles, no prior intelligence. The first ${withCommas(LARGE_FILE_ROWS)} payments are replayed.`}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface MapRowProps {
  field: FieldSpec;
  header: readonly string[];
  used: ReadonlySet<string>;
  binding: { column: string | null; unit?: AmountUnit; mode?: TimestampMode } | null;
  onColumn: (column: string | null) => void;
  onUnit: (unit: AmountUnit) => void;
  onMode: (mode: TimestampMode) => void;
}

function MapRow({ field, header, used, binding, onColumn, onUnit, onMode }: MapRowProps) {
  const column = binding?.column ?? '';
  const quiet = field.whenMissing?.quiet === true;
  const supplied = column !== '';

  return (
    <div className={`map-row${supplied ? ' is-mapped' : ''}`}>
      <div className="map-label">
        <label className="label" htmlFor={`map-${field.path}`}>
          {field.label}
          {field.required && <span className="req" title="Required"> ·</span>}
        </label>
        <p className="muted tiny">{field.help}</p>
      </div>

      <div className="map-control">
        <select className="select"
          id={`map-${field.path}`}
          value={column}
          onChange={(e) => onColumn(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">Not supplied</option>
          {header.map((h) => (
            <option key={h} value={h} disabled={used.has(h) && h !== column}>
              {h}
            </option>
          ))}
        </select>

        {supplied && field.kind === 'amount' && (
          <select className="select" aria-label={`${field.label} unit`} value={binding?.unit ?? 'rupees'} onChange={(e) => onUnit(e.target.value as AmountUnit)}>
            <option value="rupees">rupees</option>
            <option value="paise">paise</option>
          </select>
        )}

        {supplied && field.kind === 'timestamp' && (
          <select className="select" aria-label={`${field.label} format`} value={binding?.mode ?? 'auto'} onChange={(e) => onMode(e.target.value as TimestampMode)}>
            <option value="auto">detect</option>
            <option value="day_first">day/month/year</option>
            <option value="month_first">month/day/year</option>
            <option value="iso">ISO 8601</option>
            <option value="epoch_ms">epoch ms</option>
            <option value="epoch_s">epoch seconds</option>
            <option value="step_hours">step number, 1 per hour</option>
          </select>
        )}
      </div>

      <p className={`map-missing tiny${quiet ? ' is-quiet' : ''}`}>
        {supplied ? '' : field.whenMissing?.note ?? ''}
        {!supplied && quiet && <span className="quiet-dot" aria-label="attacker-controllable indicator left quiet" />}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ReportView({ dataset, preview = false }: { dataset: ImportedDataset; preview?: boolean }) {
  const r = dataset.report;
  const skipped = Object.entries(r.skipped);

  return (
    <section className="panel">
      <header><h2>What this file can and cannot show
        {preview && <span className="th-sub">from the rows read so far</span>}
      </h2></header>

      <div className="stats mb">
        <Stat label="Payments" value={withCommas(r.rowsKept)} sub={`of ${withCommas(r.rowsRead)} rows`} />
        <Stat label="Payers" value={withCommas(r.distinctPayers)} sub={`median ${r.medianPaymentsPerPayer} payments each`} />
        <Stat label="Beneficiaries" value={withCommas(r.distinctPayees)} sub={`${(r.repeatBeneficiaryRate * 100).toFixed(0)}% repeat`} />
        <Stat
          label="Ground truth"
          value={r.labelled ? withCommas(r.fraudCount) : 'none'}
          sub={r.labelled ? 'payments marked fraud' : 'accuracy cannot be scored'}
        />
      </div>

      {r.warnings.length > 0 && (
        <ul className="warnings">
          {r.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {r.assumptions.length > 0 && (
        <p className="muted small">
          <strong>Assumed:</strong> {r.assumptions.join(' ')}
        </p>
      )}

      {r.quiet.length > 0 && (
        <details className="disclose">
          <summary>
            {r.quiet.length} field{r.quiet.length === 1 ? '' : 's'} left at the value an attacker would choose
          </summary>
          <ul className="plain-list">
            {r.quiet.map((q) => (
              <li key={q.path}>
                <strong>{q.label}.</strong> {q.note}
              </li>
            ))}
          </ul>
        </details>
      )}

      {r.substituted.length > 0 && (
        <details className="disclose">
          <summary>{r.substituted.length} fields filled in harmlessly</summary>
          <ul className="plain-list">
            {r.substituted.map((q) => (
              <li key={q.path}>
                <strong>{q.label}.</strong> {q.note}
              </li>
            ))}
          </ul>
        </details>
      )}

      {(skipped.length > 0 || r.columnIssues.length > 0) && (
        <details className="disclose">
          <summary>
            {withCommas(r.rowsSkipped)} row{r.rowsSkipped === 1 ? '' : 's'} not replayed
            {r.columnIssues.length > 0 ? `, ${r.columnIssues.length} column${r.columnIssues.length === 1 ? '' : 's'} with unreadable cells` : ''}
          </summary>
          <ul className="plain-list">
            {skipped.map(([reason, count]) => (
              <li key={reason}>
                <span className="mono">{withCommas(count)}</span> {reason}
              </li>
            ))}
            {r.columnIssues.map((i) => (
              <li key={`${i.path}-${i.column}`}>
                <strong>{i.label}</strong> (column <span className="mono">{i.column}</span>):{' '}
                {withCommas(i.count)} cell{i.count === 1 ? '' : 's'} could not be read, such as{' '}
                {i.samples.map((s) => `“${s}”`).join(', ')}.
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

