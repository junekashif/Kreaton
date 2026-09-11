'use client';

import type { Action } from '@kreaton/core';
import { AnimatedNumber } from './AnimatedNumber';
import { DecisionGlyph } from './DecisionTag';
import { withCommas } from '../lib/format';

/**
 * What can happen to a payment, in the words a payer would use, carrying the
 * running count of each.
 *
 * This is the one piece of explanation on the console, and it is deliberately
 * also the legend: the glyph and hue beside each line are the same ones the
 * ribbon and the feed use, so reading the header teaches the vocabulary for
 * the rest of the screen rather than sitting above it as decoration.
 */
const KEY: readonly { action: Action; title: string; gloss: string }[] = [
  {
    action: 'APPROVE',
    title: 'Let through',
    gloss: 'Matches how this payer normally pays. It settles untouched.',
  },
  {
    action: 'STEP_UP',
    title: 'Held to verify',
    gloss: 'Something is off. The payer confirms who they are paying before it moves.',
  },
  {
    action: 'BLOCK',
    title: 'Blocked',
    gloss: 'Almost certainly a scam. The money never leaves the account.',
  },
];

export function DecisionKey({ counts }: { counts: Record<Action, number> }) {
  return (
    <ul className="key" aria-label="What the engine can do with a payment">
      {KEY.map((k) => (
        <li key={k.action} className="key-item" data-action={k.action}>
          <span className="key-head">
            <DecisionGlyph action={k.action} size={11} />
            <span className="key-title">{k.title}</span>
            <span className="key-count num">
              <AnimatedNumber value={counts[k.action]} format={(n) => withCommas(Math.round(n))} />
            </span>
          </span>
          <span className="key-gloss">{k.gloss}</span>
        </li>
      ))}
    </ul>
  );
}
