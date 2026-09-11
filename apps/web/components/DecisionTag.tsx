import type { Action } from '@kreaton/core';
import { ACTION_LABEL } from '../lib/format';

/**
 * The three decision glyphs: a bar for approve, a ring for hold, a cross for
 * block. Colour alone cannot carry the decision -- approve and block sit at a
 * deutan delta-E of 12.8, comfortable but not enormous, and the console is
 * read in greyscale screenshots as often as in colour -- so every place a
 * decision appears, this shape appears with it.
 */
export function DecisionGlyph({ action, size = 10 }: { action: Action; size?: number }) {
  return (
    <svg className="glyph" viewBox="0 0 10 10" width={size} height={size} aria-hidden>
      {action === 'APPROVE' ? (
        <line x1={5} x2={5} y1={1} y2={9} stroke="currentColor" strokeWidth={1.75} />
      ) : action === 'STEP_UP' ? (
        <circle cx={5} cy={5} r={3.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
      ) : (
        <path d="M1.5,1.5 L8.5,8.5 M8.5,1.5 L1.5,8.5" stroke="currentColor" strokeWidth={1.75} />
      )}
    </svg>
  );
}

/** A decision, shown as a glyph and a word as well as a hue. */
export function DecisionTag({ action, override }: { action: Action; override?: boolean }) {
  return (
    <span className="decision" data-action={action} title={override ? 'Protocol override applied' : undefined}>
      <DecisionGlyph action={action} />
      {ACTION_LABEL[action]}
      {override ? <span className="faint">*</span> : null}
    </span>
  );
}
