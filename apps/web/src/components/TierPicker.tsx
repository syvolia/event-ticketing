import type { TierWithAvailability } from '@ticketing/shared';
import { formatMoney } from '../lib/format.js';

export interface TierSelection {
  [tierId: string]: number;
}

interface Props {
  tiers: TierWithAvailability[];
  selection: TierSelection;
  onChange: (next: TierSelection) => void;
}

export function TierPicker({ tiers, selection, onChange }: Props): JSX.Element {
  function setQuantity(tier: TierWithAvailability, next: number): void {
    const clamped = Math.max(0, Math.min(next, Math.min(tier.available, tier.perOrderMax)));
    onChange({ ...selection, [tier.id]: clamped });
  }

  return (
    <div className="space-y-3">
      {tiers.map((tier) => {
        const qty = selection[tier.id] ?? 0;
        const closed = tier.available === 0;
        const max = Math.min(tier.available, tier.perOrderMax);
        return (
          <div key={tier.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold">{tier.name}</h3>
                  {closed ? (
                    <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-danger">
                      Sold out
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-neutral-400">
                  {formatMoney(tier.priceMinor, tier.currency)}
                  <span className="mx-2 text-neutral-700">·</span>
                  <span className={tier.available <= 5 ? 'text-warn' : ''}>
                    {tier.available} available
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-neutral-600">Max {tier.perOrderMax} per order</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="h-9 w-9 rounded-full border border-edge text-lg disabled:opacity-30"
                  onClick={() => setQuantity(tier, qty - 1)}
                  disabled={qty === 0}
                  aria-label={`Decrease ${tier.name}`}
                >
                  −
                </button>
                <span className="w-8 text-center font-mono text-lg">{qty}</span>
                <button
                  type="button"
                  className="h-9 w-9 rounded-full border border-edge text-lg disabled:opacity-30"
                  onClick={() => setQuantity(tier, qty + 1)}
                  disabled={qty >= max}
                  aria-label={`Increase ${tier.name}`}
                >
                  +
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
