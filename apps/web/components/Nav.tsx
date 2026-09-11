'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '../lib/use-session';
import { istClock } from '../lib/format';

const ITEMS = [
  { href: '/', label: 'Console' },
  { href: '/policy', label: 'Policy' },
  { href: '/trace', label: 'Trace' },
  { href: '/audit', label: 'Audit' },
  { href: '/adversarial', label: 'Adversarial' },
  { href: '/portfolio', label: 'Portfolio' },
  { href: '/model', label: 'Model' },
] as const;

export function Nav() {
  const pathname = usePathname();
  const { snap } = useSession();
  const live = snap.status === 'ready';

  return (
    <nav className="nav" aria-label="Primary">
      <Link href="/" className="brand">
        <span className="mark" aria-hidden />
        Kreaton
        <span className="ps hide-narrow">APP fraud interceptor</span>
      </Link>
      {ITEMS.map((item) => {
        const current =
          item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className="item"
            aria-current={current ? 'page' : undefined}
          >
            {item.label}
          </Link>
        );
      })}
      <div className="status">
        <span className="live" data-on={live}>
          {snap.status === 'loading'
            ? 'loading engine'
            : live
              ? `engine clock ${istClock(snap.clockMs)} IST`
              : snap.status === 'error'
                ? 'engine failed to load'
                : 'engine idle'}
        </span>
        {live ? (
          <span className="mono hide-narrow" title="Policy digest in force">
            policy {snap.policyHash.slice(0, 8)}
          </span>
        ) : null}
      </div>
    </nav>
  );
}
