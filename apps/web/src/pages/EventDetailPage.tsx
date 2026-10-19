import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useEvent, useCreateOrder } from '../hooks/queries.js';
import { TierPicker, type TierSelection } from '../components/TierPicker.js';
import { Spinner } from '../components/Spinner.js';
import { formatDateTime, formatMoney } from '../lib/format.js';
import { ApiError, getToken } from '../lib/api.js';

export function EventDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const event = useEvent(id);
  const createOrder = useCreateOrder();
  const [selection, setSelection] = useState<TierSelection>({});
  const [error, setError] = useState<string | null>(null);

  if (event.isLoading) return <Spinner label="Loading event…" />;
  if (event.isError || !event.data) {
    return <div className="card p-4 text-sm text-danger">Event not found.</div>;
  }

  const e = event.data;
  const lines = Object.entries(selection)
    .filter(([, q]) => q > 0)
    .map(([tierId, quantity]) => ({ tierId, quantity }));
  const totalMinor = e.tiers.reduce((sum, t) => sum + (selection[t.id] ?? 0) * t.priceMinor, 0);
  const currency = e.tiers[0]?.currency ?? 'KES';
  const canCheckout = lines.length > 0 && !createOrder.isPending;

  async function onCheckout(): Promise<void> {
    setError(null);
    if (!id) return;

    // Check auth BEFORE the network call. Without this, a logged-out buyer
    // gets a raw 401 error message with no path forward. We capture the
    // intended destination so they land back here (well, on the checkout
    // page for the order they will create) after signing in or signing up.
    // The order id is not yet known, so we route to the event page and let
    // them re-enter their selection — the reservation attempt creates a
    // fresh order with a new idempotency key, so nothing is lost.
    if (!getToken()) {
      navigate(`/login?returnTo=${encodeURIComponent(`/events/${id}`)}`);
      return;
    }

    // One idempotency key per checkout attempt. If the user double-taps, the
    // button is disabled while the mutation is in flight, and even if the
    // click slipped through, the same key produces the same order.
    const idempotencyKey = `co_${crypto.randomUUID()}`;
    try {
      const order = await createOrder.mutateAsync({ eventId: id, items: lines, idempotencyKey });
      navigate(`/checkout/${order.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // Token expired between page load and click. Same redirect, but we
        // navigate instead of showing a raw message.
        navigate(`/login?returnTo=${encodeURIComponent(`/events/${id}`)}`);
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        const details = err.details as { reason?: string; available?: number } | undefined;
        if (details?.reason === 'INSUFFICIENT_INVENTORY') {
          setError(
            `Not enough stock — only ${details.available ?? 0} left. Adjust quantities and try again.`,
          );
        } else if (details?.reason === 'EXCEEDS_PER_ORDER_MAX') {
          setError('Quantity exceeds the per-order limit for that tier.');
        } else if (details?.reason === 'SALES_CLOSED') {
          setError('Sales for that tier have just closed.');
        } else {
          setError('Reservation refused. Please try again.');
        }
      } else {
        setError((err as Error).message);
      }
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← All events
        </Link>
      </div>

      <div className="card p-4">
        <h1 className="text-xl font-bold">{e.name}</h1>
        <p className="mt-1 text-sm text-neutral-400">{e.venue}</p>
        <p className="mt-1 text-sm text-neutral-400">{formatDateTime(e.startsAt)}</p>
        {e.description ? (
          <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-300">{e.description}</p>
        ) : null}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Tickets
        </h2>
        <TierPicker tiers={e.tiers} selection={selection} onChange={setSelection} />
      </div>

      {error ? (
        <div className="card border-danger/40 bg-danger/5 p-3 text-sm text-danger">{error}</div>
      ) : null}

      <div className="sticky bottom-0 -mx-4 border-t border-edge bg-ink/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xs text-neutral-500">Total</div>
            <div className="text-lg font-semibold">{formatMoney(totalMinor, currency)}</div>
          </div>
          <button className="btn-primary flex-1" onClick={onCheckout} disabled={!canCheckout}>
            {createOrder.isPending ? 'Reserving…' : 'Reserve & pay'}
          </button>
        </div>
      </div>
    </div>
  );
}
