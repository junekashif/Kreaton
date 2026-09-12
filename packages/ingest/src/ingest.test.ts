import { describe, expect, it } from 'vitest';
import { parseDelimited, sniffDelimiter } from './delimited.js';
import { coerceAmount, coerceTimestamp } from './coerce.js';
import { detectMapping, missingRequired, withDefaults } from './mapping.js';
import { buildDataset, slugIdentity } from './build.js';
import { readSource } from './source.js';
import type { Millis } from '@kreaton/core';

const BASE = Date.UTC(2026, 0, 1) as Millis;

describe('delimited parsing', () => {
  it('sniffs the delimiter from consistent counts, not raw frequency', () => {
    // The narration carries commas; the semicolon count is what is consistent.
    const text = 'date;name;amount\n01/01/2026;SHOP, THE;10\n02/01/2026;A, B, C;20\n';
    expect(sniffDelimiter(text)).toBe(';');
  });

  it('keeps delimiters and newlines inside quoted fields', () => {
    const text = 'a,b\n"one, two","line\nbreak"\n';
    const { header, rows } = parseDelimited(text);
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['one, two', 'line\nbreak']]);
  });

  it('reads doubled quotes as one quote', () => {
    const { rows } = parseDelimited('a\n"say ""hi"""\n');
    expect(rows[0]).toEqual(['say "hi"']);
  });

  it('strips a byte order mark from the first header', () => {
    const { header } = parseDelimited('﻿date,amount\n01/01/2026,5\n');
    expect(header[0]).toBe('date');
  });

  it('reports ragged rows rather than dropping them silently', () => {
    const { rows, ragged } = parseDelimited('a,b,c\n1,2\n1,2,3\n');
    expect(rows).toHaveLength(2);
    expect(ragged).toEqual([{ line: 2, cells: 2 }]);
  });

  it('handles a final row with no trailing newline', () => {
    const { rows } = parseDelimited('a,b\n1,2');
    expect(rows).toEqual([['1', '2']]);
  });
});

describe('amount coercion', () => {
  it('reads Indian digit grouping', () => {
    expect(coerceAmount('1,20,300.50', 'rupees').value).toBe(12_030_050);
  });

  it('reads a currency symbol and a Dr marker', () => {
    expect(coerceAmount('₹ 1,250.00 Dr', 'rupees').value).toBe(125_000);
  });

  it('treats accounting parentheses as an outgoing amount, not a negative', () => {
    const r = coerceAmount('(500.00)', 'rupees');
    expect(r.value).toBe(50_000);
    expect(r.note).toMatch(/sign was dropped/);
  });

  it('does not multiply a column already in paise', () => {
    expect(coerceAmount('150000', 'paise').value).toBe(150_000);
  });
});

describe('timestamp coercion', () => {
  it('reads epoch milliseconds', () => {
    expect(coerceTimestamp('1757000000000', 'auto', BASE).value).toBe(1_757_000_000_000);
  });

  it('reads epoch seconds by range', () => {
    const r = coerceTimestamp('1757000000', 'auto', BASE);
    expect(r.value).toBe(1_757_000_000_000);
    expect(r.note).toMatch(/seconds/);
  });

  it('reads a small integer as a PaySim step of one hour', () => {
    expect(coerceTimestamp('3', 'auto', BASE).value).toBe(BASE + 3 * 3_600_000);
  });

  it('defaults slashed dates to day first and says so when ambiguous', () => {
    const r = coerceTimestamp('03/04/2026', 'auto', BASE);
    expect(new Date(r.value).getUTCMonth()).toBe(3); // April
    expect(r.note).toMatch(/day\/month order assumed/);
  });

  it('resolves the order from the data when one part exceeds twelve', () => {
    const r = coerceTimestamp('25/04/2026', 'auto', BASE);
    expect(new Date(r.value).getUTCDate()).toBe(25);
    expect(r.note).toBeUndefined();
  });

  it('honours an explicit month-first instruction', () => {
    const r = coerceTimestamp('03/04/2026', 'month_first', BASE);
    expect(new Date(r.value).getUTCMonth()).toBe(2); // March
  });
});

describe('mapping detection', () => {
  it('recognises PaySim and reads its step column as hours', () => {
    const header = ['step', 'type', 'amount', 'nameOrig', 'newbalanceOrig', 'nameDest', 'isFraud'];
    const { mapping, preset } = detectMapping(header);
    expect(preset?.id).toBe('paysim');
    expect(mapping.payerId?.column).toBe('nameOrig');
    expect(mapping.ts?.mode).toBe('step_hours');
  });

  it('prefers the longer synonym when two fields could claim a column', () => {
    const { mapping } = detectMapping(['Beneficiary Name', 'Amount', 'Payer']);
    expect(mapping.payeeName?.column).toBe('Beneficiary Name');
  });

  it('never binds one column to two fields', () => {
    const { mapping } = detectMapping(['name', 'amount', 'account']);
    const columns = Object.values(mapping).map((b) => b.column).filter((c) => c !== null);
    expect(new Set(columns).size).toBe(columns.length);
  });

  it('reads a column named in paise as paise', () => {
    expect(withDefaults('amountPaise', { column: 'amountPaise' }).unit).toBe('paise');
    expect(withDefaults('amountPaise', { column: 'Amount' }).unit).toBe('rupees');
  });

  it('blocks only on the amount, because the other two have substitutes', () => {
    const { mapping } = detectMapping(['Date', 'Narration', 'Debit', 'Balance']);
    expect(missingRequired(mapping)).toHaveLength(0);
    const { mapping: noAmount } = detectMapping(['Date', 'Narration']);
    expect(missingRequired(noAmount).map((f) => f.path)).toEqual(['amountPaise']);
  });
});

describe('building a dataset', () => {
  const statement =
    'Date,Narration,Debit,Credit,Balance\n' +
    '03/04/2026,RAMESH TRADERS,"1,250.00",,"45,300.00"\n' +
    '04/04/2026,SALARY,,"75,000.00","1,20,300.00"\n' +
    '05/04/2026,Ramesh Traders.,"2,000.00",,"43,300.00"\n';

  it('reads a statement with no payer and no beneficiary id', () => {
    const src = readSource(statement);
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });

    expect(ds.report.rowsKept).toBe(2);
    expect(ds.report.skipped['money in, not a payment']).toBe(1);
    expect(ds.transactions.every((t) => t.payerId === 'account_holder')).toBe(true);
    expect(ds.report.assumptions.join(' ')).toMatch(/no payer column/i);
  });

  it('folds punctuation and case so a repeat counterparty is one beneficiary', () => {
    const src = readSource(statement);
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.report.distinctPayees).toBe(1);
    // The second payment to the same beneficiary is not a new one.
    expect(ds.transactions[1]!.context.beneficiaryAddedAtMs).not.toBeNull();
    expect(ds.transactions[0]!.context.beneficiaryAddedAtMs).toBeNull();
  });

  it('orders payments by time even when the file is reversed', () => {
    const reversed =
      'date,payer,payee,amount\n' +
      '2026-04-05,p1,e1,300\n' +
      '2026-04-03,p1,e2,100\n' +
      '2026-04-04,p1,e3,200\n';
    const src = readSource(reversed);
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.transactions.map((t) => t.amountPaise)).toEqual([10_000, 20_000, 30_000]);
  });

  it('treats a PaySim PAYMENT as money leaving, not arriving', () => {
    const src = readSource(
      'step,type,amount,nameOrig,nameDest,isFraud\n1,PAYMENT,100,C1,M1,0\n2,CASH_IN,500,C1,M2,0\n',
    );
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.report.rowsKept).toBe(1);
    expect(ds.transactions[0]!.payeeId).toBe('M1');
  });

  it('warns that a file with no session context is the suppressed-indicator case', () => {
    const src = readSource('date,payer,payee,amount\n2026-04-03,p1,e1,100\n');
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.report.warnings.join(' ')).toMatch(/suppressed every indicator/);
    expect(ds.report.quiet.some((q) => q.path === 'context.activeCall')).toBe(true);
  });

  it('collects unreadable cells instead of failing the import', () => {
    const src = readSource('date,payer,payee,amount\n2026-04-03,p1,e1,not-a-number\n2026-04-04,p1,e1,100\n');
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.report.rowsKept).toBe(1);
    expect(ds.report.columnIssues[0]!.samples).toContain('not-a-number');
  });

  it('reads nested JSON through the same mapping path as a spreadsheet', () => {
    const src = readSource(
      '[{"txnId":"a1","ts":1757000000000,"payerId":"p1","payeeId":"e1","payeeName":"ACME",' +
        '"amountPaise":150000,"context":{"activeCall":true},"label":{"isFraud":true}}]',
    );
    expect(src.format).toBe('json');
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.transactions[0]!.amountPaise).toBe(150_000);
    expect(ds.transactions[0]!.context.activeCall).toBe(true);
    expect(ds.report.fraudCount).toBe(1);
  });

  it('releases a confirmed-mule marking at the row timestamp, not retroactively', () => {
    const src = readSource(
      'date,payer,payee,amount,mule\n2026-04-03,p1,e1,100,no\n2026-04-05,p2,e1,100,yes\n',
    );
    const { mapping } = detectMapping(src.header);
    const ds = buildDataset(src.rows, mapping, { baseMs: BASE });
    expect(ds.intel).toHaveLength(1);
    expect(ds.intel[0]!.ts).toBe(Date.UTC(2026, 3, 5));
  });
});

describe('identity slugs', () => {
  it('folds case, punctuation and rail prefixes together', () => {
    expect(slugIdentity('UPI/RAMESH TRADERS.')).toBe(slugIdentity('Ramesh Traders'));
  });

  it('never returns an empty identity', () => {
    expect(slugIdentity('***')).toBe('unnamed');
  });
});
