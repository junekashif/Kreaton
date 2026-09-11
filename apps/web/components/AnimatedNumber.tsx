'use client';

import { useEffect, useRef, useState } from 'react';

/* Ease-out cubic: figures arrive quickly and settle, rather than drifting. */
const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * A figure that moves to its new value instead of jumping to it.
 *
 * The console's numbers change several times a second under playback, and a
 * figure that snaps is read as a different figure rather than the same one
 * changing. Motion here is the only thing saying "this is still the same
 * quantity". Under prefers-reduced-motion it snaps, which is the correct
 * behaviour rather than a degraded one.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 320,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
}) {
  const [shown, setShown] = useState(value);
  const shownRef = useRef(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const from = shownRef.current;
    if (reduced || from === value) {
      shownRef.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      /* The frame timestamp can predate the start captured above, because it
         is the time the frame began rather than the time this effect ran. An
         unclamped negative t sends the ease cubic past 1, the figure
         overshoots, and the overshoot becomes the next animation's starting
         point -- which diverges rather than settling. */
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const v = from + (value - from) * ease(t);
      shownRef.current = v;
      setShown(v);
      if (t < 1) frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [value, duration]);

  return <>{format(shown)}</>;
}
