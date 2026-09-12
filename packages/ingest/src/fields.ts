/**
 * What a dataset can supply, and what happens when it does not.
 *
 * This table is the contract between an arbitrary spreadsheet and the engine.
 * Every field the interception path can read is listed once, with the header
 * names real exports use for it, and — the part that matters most — what the
 * importer substitutes when the column is absent and what that substitution
 * costs in detection power.
 *
 * That last point is not a footnote. A UPI authorisation carries session
 * context (a live call, a pasted identifier, a freshly bound device) that no
 * bank statement or public dataset contains. Importing such a file means the
 * engine sees a payment with every attacker-controllable indicator at its
 * quiet value, which is precisely the position the asymmetric evidence cap in
 * docs/MODELING.md section 4.4 exists to handle. The import report says so in
 * those words rather than silently producing a weaker score.
 */

export type FieldKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'amount'
  | 'timestamp';

export type FieldGroup = 'identity' | 'payment' | 'session' | 'device' | 'beneficiary' | 'label';

export interface FieldSpec {
  /** Dotted path into the constructed record. */
  path: string;
  label: string;
  kind: FieldKind;
  /** Grouping for the mapping interface. */
  group: FieldGroup;
  /**
   * True when no substitute is defensible and the import cannot proceed
   * without it.
   */
  required: boolean;
  /** Lowercased header fragments, matched longest-first during auto-detection. */
  synonyms: readonly string[];
  enumValues?: readonly string[];
  help: string;
  /** What is used when the column is absent, and what it costs. */
  whenMissing?: {
    note: string;
    /** True when the substitute is the value an attacker would want. */
    quiet?: boolean;
  };
}

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  identity: 'Who paid whom',
  payment: 'The payment',
  session: 'What was happening during the payment',
  device: 'Device and SIM',
  beneficiary: 'What is known about the receiving account',
  label: 'Ground truth, if you have it',
};

export const FIELDS: readonly FieldSpec[] = [
  // --- identity ----------------------------------------------------------
  {
    path: 'txnId',
    label: 'Payment reference',
    kind: 'string',
    group: 'identity',
    required: false,
    synonyms: ['txnid', 'txn_id', 'transaction id', 'transactionid', 'reference', 'ref no', 'refno', 'utr', 'rrn'],
    help: 'Unique reference for the payment. Used as the key everywhere in the console.',
    whenMissing: { note: 'Numbered from the row position, imp_000001 upward.' },
  },
  {
    path: 'payerId',
    label: 'Payer',
    kind: 'string',
    group: 'identity',
    required: true,
    synonyms: [
      'payerid', 'payer_id', 'payer', 'sender', 'from account', 'fromaccount', 'account number',
      'accountnumber', 'account no', 'customer id', 'customerid', 'nameorig', 'debtor',
    ],
    help: 'Who is paying. Every behavioural signal is computed against this identity, so it must be stable across rows.',
  },
  {
    path: 'payerVpa',
    label: 'Payer UPI ID',
    kind: 'string',
    group: 'identity',
    required: false,
    synonyms: ['payervpa', 'payer_vpa', 'payer upi', 'sender vpa', 'from vpa'],
    help: 'The payer UPI handle, when the dataset has one.',
    whenMissing: { note: 'Derived from the payer identifier as <payer>@imported.' },
  },
  {
    path: 'payeeId',
    label: 'Beneficiary',
    kind: 'string',
    group: 'identity',
    required: true,
    synonyms: [
      'payeeid', 'payee_id', 'payee', 'beneficiary', 'receiver', 'recipient', 'to account',
      'toaccount', 'namedest', 'creditor', 'merchant id', 'merchantid',
    ],
    help: 'Who is being paid. The payee-graph signals key on this, so a dataset that never repeats a beneficiary loses that whole group.',
  },
  {
    path: 'payeeVpa',
    label: 'Beneficiary UPI ID',
    kind: 'string',
    group: 'identity',
    required: false,
    synonyms: ['payeevpa', 'payee_vpa', 'payee upi', 'beneficiary vpa', 'to vpa', 'vpa', 'upi id', 'upiid'],
    help: 'The beneficiary UPI handle, when the dataset has one.',
    whenMissing: { note: 'Derived from the beneficiary identifier as <payee>@imported.' },
  },
  {
    path: 'payeeName',
    label: 'Beneficiary name',
    kind: 'string',
    group: 'identity',
    required: false,
    synonyms: [
      'payeename', 'payee_name', 'payee name', 'beneficiary name', 'beneficiaryname', 'name',
      'recipient name', 'merchant name', 'merchant', 'counterparty', 'narration', 'particulars', 'description',
    ],
    help: 'The name registered at the receiving institution. Shown throughout the console and in the audit record.',
    whenMissing: { note: 'Falls back to the beneficiary identifier.' },
  },

  // --- payment -----------------------------------------------------------
  {
    path: 'amountPaise',
    label: 'Amount',
    kind: 'amount',
    group: 'payment',
    required: true,
    synonyms: [
      'amountpaise', 'amount_paise', 'amount', 'txn amount', 'transaction amount', 'value',
      'debit', 'withdrawal', 'paid out', 'inr', 'rupees',
    ],
    help: 'The amount of the payment. Read as rupees by default; switch the unit if the column is already in paise.',
  },
  {
    path: 'ts',
    label: 'Timestamp',
    kind: 'timestamp',
    group: 'payment',
    required: false,
    synonyms: [
      'ts', 'timestamp', 'datetime', 'date time', 'txn date', 'transaction date', 'value date',
      'valuedate', 'date', 'time', 'created at', 'createdat', 'posted', 'step',
    ],
    help: 'When the payment was authorised. Order matters more than absolute time: profiles are built forward through the file.',
    whenMissing: { note: 'Rows are spaced five minutes apart, ending now, preserving file order.' },
  },
  {
    path: 'direction',
    label: 'Direction',
    kind: 'enum',
    group: 'payment',
    required: false,
    enumValues: ['debit', 'credit'],
    synonyms: ['direction', 'dr/cr', 'drcr', 'cr/dr', 'debit/credit', 'indicator', 'txn type', 'transaction type', 'type'],
    help: 'For statement-style files that mix money in and money out. Only debits are push payments; credits seed the payer balance and are not scored.',
    whenMissing: { note: 'Every row is treated as an outgoing payment.' },
  },
  {
    path: 'creditPaise',
    label: 'Credit column',
    kind: 'amount',
    group: 'payment',
    required: false,
    synonyms: ['credit', 'deposit', 'paid in', 'cr amount', 'money in', 'inflow'],
    help: 'Statement layouts that put money in and money out in two columns. A row with a credit is an inflow: it seeds the balance and is not scored.',
    whenMissing: { note: 'Not used.' },
  },
  {
    path: 'balancePaise',
    label: 'Balance after payment',
    kind: 'amount',
    group: 'payment',
    required: false,
    synonyms: ['balance', 'closing balance', 'closingbalance', 'available balance', 'running balance', 'newbalanceorig', 'balance after'],
    help: 'Account balance, if the file carries one. Seeds the drain-ratio signal with a real figure instead of the spend-based proxy.',
    whenMissing: { note: 'The engine estimates available balance from observed spend.' },
  },
  {
    path: 'channel',
    label: 'Channel',
    kind: 'enum',
    group: 'payment',
    required: false,
    enumValues: ['p2p', 'p2m', 'collect'],
    synonyms: ['channel', 'payment type', 'paymenttype', 'mode', 'txn mode'],
    help: 'Person to person, person to merchant, or a collect request.',
    whenMissing: { note: 'Treated as person to person.' },
  },
  {
    path: 'note',
    label: 'Remark',
    kind: 'string',
    group: 'payment',
    required: false,
    synonyms: ['note', 'remark', 'remarks', 'memo', 'comment', 'purpose'],
    help: 'The free-text remark attached to the payment.',
  },

  // --- session context ---------------------------------------------------
  {
    path: 'context.activeCall',
    label: 'On a call',
    kind: 'boolean',
    group: 'session',
    required: false,
    synonyms: ['activecall', 'active_call', 'on call', 'oncall', 'call active', 'in call'],
    help: 'Whether a voice or video call was in progress at authorisation. This is the single most distinguishing indicator of authorised push payment fraud.',
    whenMissing: { note: 'No call, so the coercion signal cannot fire.', quiet: true },
  },
  {
    path: 'context.activeCallSeconds',
    label: 'Call duration',
    kind: 'number',
    group: 'session',
    required: false,
    synonyms: ['activecallseconds', 'call seconds', 'callduration', 'call duration', 'call length'],
    help: 'Seconds the concurrent call had been running. The coercion signal scales with this, because a brief call is unremarkable and a forty-minute one is not.',
    whenMissing: { note: 'Zero.', quiet: true },
  },
  {
    path: 'context.screenShareActive',
    label: 'Screen sharing',
    kind: 'boolean',
    group: 'session',
    required: false,
    synonyms: ['screenshare', 'screen share', 'screenshareactive', 'sharing screen'],
    help: 'Whether the payer screen was being shared at authorisation.',
    whenMissing: { note: 'Not sharing.', quiet: true },
  },
  {
    path: 'context.remoteAccessAppRunning',
    label: 'Remote access app running',
    kind: 'boolean',
    group: 'session',
    required: false,
    synonyms: ['remoteaccess', 'remote access', 'remoteaccessapprunning', 'anydesk', 'teamviewer'],
    help: 'Whether remote-control software was running on the device.',
    whenMissing: { note: 'Not running.', quiet: true },
  },
  {
    path: 'context.appSwitchCount',
    label: 'App switches',
    kind: 'integer',
    group: 'session',
    required: false,
    synonyms: ['appswitchcount', 'app switches', 'appswitches', 'switch count'],
    help: 'How many times the payer left and returned to the app before authorising. A victim re-reading instructions switches repeatedly.',
    whenMissing: { note: 'Zero.', quiet: true },
  },
  {
    path: 'context.secondsFromOpenToAuthorize',
    label: 'Seconds to authorise',
    kind: 'number',
    group: 'session',
    required: false,
    synonyms: [
      'secondsfromopentoauthorize', 'seconds to authorise', 'seconds to authorize',
      'seconds to pay', 'time to pay', 'time to authorise', 'session seconds',
    ],
    help: 'Time from opening the app to pressing pay. Coached payers move faster than usual.',
    whenMissing: { note: 'Thirty seconds, an unremarkable value.', quiet: true },
  },
  {
    path: 'context.vpaEnteredBy',
    label: 'How the payee was entered',
    kind: 'enum',
    group: 'session',
    required: false,
    enumValues: ['typed', 'pasted', 'qr', 'contact', 'deeplink'],
    synonyms: ['vpaenteredby', 'entry method', 'entrymethod', 'entered by', 'input method'],
    help: 'Pasting an identifier supplied over chat is the entry method scams overwhelmingly use; choosing a saved contact is the opposite.',
    whenMissing: { note: 'Typed, the neutral value.', quiet: true },
  },
  {
    path: 'context.sessionId',
    label: 'Session',
    kind: 'string',
    group: 'session',
    required: false,
    synonyms: ['sessionid', 'session_id', 'session'],
    help: 'Groups payments made in one app session.',
    whenMissing: { note: 'One session per payment.' },
  },

  // --- device ------------------------------------------------------------
  {
    path: 'deviceId',
    label: 'Device',
    kind: 'string',
    group: 'device',
    required: false,
    synonyms: ['deviceid', 'device_id', 'device', 'handset', 'terminal'],
    help: 'The authorising handset.',
    whenMissing: { note: 'One stable device per payer.' },
  },
  {
    path: 'context.isNewDevice',
    label: 'Unrecognised device',
    kind: 'boolean',
    group: 'device',
    required: false,
    synonyms: ['isnewdevice', 'new device', 'newdevice', 'unknown device'],
    help: 'Whether the handset is unrecognised for this payer.',
    whenMissing: { note: 'Recognised.', quiet: true },
  },
  {
    path: 'context.deviceBoundAtMs',
    label: 'Device bound at',
    kind: 'timestamp',
    group: 'device',
    required: false,
    synonyms: ['deviceboundatms', 'devicebound', 'device bound', 'device registered', 'binding date'],
    help: 'When the handset was bound to the account. Drives the device-trust-age signal.',
    whenMissing: { note: 'One year before the payment, a well-trusted device.', quiet: true },
  },
  {
    path: 'context.simChangedRecently',
    label: 'Recent SIM swap',
    kind: 'boolean',
    group: 'device',
    required: false,
    synonyms: ['simchangedrecently', 'sim changed', 'simswap', 'sim swap'],
    help: 'Whether the SIM was swapped inside the risk window. A swap collapses device trust age to zero.',
    whenMissing: { note: 'No swap.', quiet: true },
  },

  // --- beneficiary intelligence -----------------------------------------
  {
    path: 'payee.firstSeenMs',
    label: 'Beneficiary account opened',
    kind: 'timestamp',
    group: 'beneficiary',
    required: false,
    synonyms: ['payeefirstseen', 'beneficiary opened', 'account opened', 'payee age', 'beneficiary since'],
    help: 'When the receiving account was first seen anywhere in the network. Mule accounts are disproportionately young.',
    whenMissing: { note: 'First appearance in the file, so the signal still works within the dataset.' },
  },
  {
    path: 'payee.outboundVelocityRatio',
    label: 'Beneficiary onward velocity',
    kind: 'number',
    group: 'beneficiary',
    required: false,
    synonyms: ['outboundvelocity', 'outboundvelocityratio', 'onward velocity', 'velocity ratio', 'passthrough'],
    help: 'Fraction of money in that leaves within the hour, between 0 and 1. This is supplied intelligence a sending institution receives rather than observes; it is what separates a mule from a busy merchant.',
    whenMissing: { note: 'Zero, meaning no beneficiary intelligence. The fan-in signal loses most of its power.', quiet: true },
  },
  {
    path: 'payee.confirmedMule',
    label: 'Confirmed mule',
    kind: 'boolean',
    group: 'beneficiary',
    required: false,
    synonyms: ['confirmedmule', 'confirmed mule', 'mule', 'blacklisted', 'flagged account'],
    help: 'Whether an investigation has confirmed this account as a collection account. Applied from the row timestamp onward, never retroactively.',
    whenMissing: { note: 'No confirmations, so the graph-proximity signal stays silent.', quiet: true },
  },

  // --- ground truth ------------------------------------------------------
  {
    path: 'label.isFraud',
    label: 'Known fraud',
    kind: 'boolean',
    group: 'label',
    required: false,
    synonyms: ['isfraud', 'is_fraud', 'fraud', 'is_fraudulent', 'fraudulent', 'scam', 'label', 'class', 'target'],
    help: 'Ground truth, when the dataset has it. Never read at decision time; it only enables the accuracy report after the run.',
  },
  {
    path: 'label.typology',
    label: 'Scam type',
    kind: 'string',
    group: 'label',
    required: false,
    synonyms: ['typology', 'fraud type', 'fraudtype', 'scam type', 'modus'],
    help: 'Which scam pattern, when labelled. Used for the per-typology breakdown only.',
  },
];

export const FIELDS_BY_PATH: ReadonlyMap<string, FieldSpec> = new Map(FIELDS.map((f) => [f.path, f]));

export const REQUIRED_PATHS: readonly string[] = FIELDS.filter((f) => f.required).map((f) => f.path);

/** Field paths whose absence leaves an attacker-controllable indicator quiet. */
export const QUIET_PATHS: readonly string[] = FIELDS.filter((f) => f.whenMissing?.quiet).map((f) => f.path);
