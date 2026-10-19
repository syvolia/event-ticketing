import { Link } from 'react-router-dom';
import type { EventDetail } from '@ticketing/shared';
import { formatDateTime, formatMoney } from '../lib/format.js';

export function EventCard({ event }: { event: EventDetail }): JSX.Element {
  const available = event.tiers.reduce((s, t) => s + t.available, 0);
  const prices = event.tiers.map((t) => t.priceMinor);
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const currency = event.tiers[0]?.currency ?? 'KES';
  const soldOut = available === 0;

  return (
    <Link
      to={`/events/${event.id}`}
      className="block card overflow-hidden transition hover:border-neutral-600"
    >
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold">{event.name}</h3>
            <p className="mt-0.5 truncate text-sm text-neutral-400">{event.venue}</p>
          </div>
          {soldOut ? (
            <span className="rounded-full bg-danger/10 px-2 py-1 text-xs font-semibold text-danger">
              Sold out
            </span>
          ) : (
            <span className="rounded-full bg-accent/10 px-2 py-1 text-xs font-semibold text-accent">
              {available} left
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-neutral-500">
          <span>{formatDateTime(event.startsAt)}</span>
          {event.tiers.length > 0 ? <span>from {formatMoney(minPrice, currency)}</span> : null}
        </div>
      </div>
    </Link>
  );
}
