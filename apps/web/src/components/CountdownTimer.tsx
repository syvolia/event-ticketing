import { useEffect, useState } from 'react';
import { formatCountdown } from '../lib/format.js';

interface Props {
  /** ISO timestamp. The countdown stops at 0. */
  expiresAt: string;
  onExpired?: () => void;
}

export function CountdownTimer({ expiresAt, onExpired }: Props): JSX.Element {
  const [remaining, setRemaining] = useState(() => new Date(expiresAt).getTime() - Date.now());

  useEffect(() => {
    let fired = false;
    const tick = (): void => {
      const next = new Date(expiresAt).getTime() - Date.now();
      setRemaining(next);
      if (next <= 0 && !fired) {
        fired = true;
        onExpired?.();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt, onExpired]);

  const critical = remaining <= 60_000;
  return (
    <span className={critical ? 'font-mono text-warn' : 'font-mono'}>
      {formatCountdown(remaining)}
    </span>
  );
}
