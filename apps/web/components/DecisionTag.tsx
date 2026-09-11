import type { Action } from '@kreaton/core';
import { ACTION_LABEL } from '../lib/format';

/**
 * A decision, shown as a glyph and a word as well as a hue. The three glyphs
 * are the same ones the ribbon uses: a tick for approve, a ring for hold, a
 * cross for block.
 */
export function DecisionTag({ action, override }: { action: Action; override?: boolean }) {
  return (
    <span className="decision" data-action={action} title={override ? 'Protocol override applied' : undefined}>
      <svg className="glyph" viewBox="0 0 10 10" aria-hidden>
        {action === 'APPROVE' ? (
          <line x1={5} x2={5} y1={1} y2={9} stroke="currentColor" strokeWidth={1.75} />
        ) : action === 'STEP_UP' ? (
          <circle cx={5} cy={5} r={3.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
        ) : (
          <path d="M1.5,1.5 L8.5,8.5 M8.5,1.5 L1.5,8.5" stroke="currentColor" strokeWidth={1.75} />
        )}
      </svg>
      {ACTION_LABEL[action]}
      {override ? <span className="faint">*</span> : null}
    </span>
  );
}
