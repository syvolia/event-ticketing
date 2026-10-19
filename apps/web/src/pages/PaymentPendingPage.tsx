import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useOrder } from '../hooks/queries.js';
import { CountdownTimer } from '../components/CountdownTimer.js';
import { formatMoney } from '../lib/format.js';

// Poll every 2s while waiting. Anything faster wastes API calls; anything
// slower makes the transition to success feel sluggish.
const POLL_MS = 2_000;

// After this long without a callback, surface a prominent "Still waiting?"
// panel with explicit actions. Before this point, we hide that panel so the
// primary instruction ("Check your phone") is not crowded out.
const PATIENCE_MS = 30_000;

export function PaymentPendingPage(): JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const [elapsed, setElapsed] = useState(0);
  const startedAtRef = useRef(Date.now());

  const order = useOrder(orderId, { pollMs: POLL_MS });

  useEffect(() => {
    const id = window.setInterval(() => {
      setElapsed(Date.now() - startedAtRef.current);
    }, 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Automatic transition to the success page once the order is paid. We use
  // `replace` so the browser back button returns to checkout, not to a page
  // that immediately redirects forward again.
  useEffect(() => {
    const o = order.data;
    if (!o) return;
    if (o.status === 'paid' || o.status === 'fulfilled') {
      navigate(`/orders/${o.id}/success`, { replace: true });
    }
  }, [order.data, navigate]);

  if (!orderId) return <div className="card p-4 text-sm text-danger">Missing order id.</div>;

  if (order.isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="h-12 w-12 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
        <p className="mt-4 text-sm text-neutral-400">Checking your order…</p>
      </div>
    );
  }

  if (order.isError || !order.data) {
    return (
      <div className="card border-danger/40 bg-danger/5 p-4 text-sm text-danger">
        Could not load your order.{' '}
        <Link className="underline" to="/">
          Home
        </Link>
      </div>
    );
  }

  const o = order.data;
  const payment = o.latestPayment;

  // -------------------------------------------------------------------------
  // Terminal order states — these are decisive; no polling continues.
  // -------------------------------------------------------------------------

  if (o.status === 'expired') {
    return (
      <div className="space-y-4">
        <div className="card border-warn/40 bg-warn/5 p-6 text-center">
          <div className="text-lg font-semibold text-warn">Reservation expired</div>
          <p className="mt-2 text-sm text-neutral-400">
            The hold on these tickets was released before payment completed.
          </p>
          <Link to={`/events/${o.eventId}`} className="btn-primary mt-4 w-full">
            Choose tickets again
          </Link>
        </div>
      </div>
    );
  }

  if (o.status === 'failed') {
    return (
      <div className="space-y-4">
        <div className="card border-danger/40 bg-danger/5 p-6 text-center">
          <div className="text-lg font-semibold text-danger">Payment failed</div>
          <p className="mt-2 text-sm text-neutral-400">
            {payment?.failureReason ?? 'Your payment did not go through.'}
          </p>
          <Link to={`/checkout/${o.id}`} className="btn-primary mt-4 w-full">
            Try again
          </Link>
        </div>
      </div>
    );
  }

  if (o.status === 'refund_pending' || o.status === 'refunded') {
    return (
      <div className="space-y-4">
        <div className="card border-warn/40 bg-warn/5 p-6 text-center">
          <div className="text-lg font-semibold text-warn">Refund in progress</div>
          <p className="mt-2 text-sm text-neutral-400">
            We received your payment but the tickets could not be issued. A refund of{' '}
            {formatMoney(o.totalMinor, o.currency)} is on the way.
          </p>
          <Link to="/" className="btn-secondary mt-4 w-full">
            Home
          </Link>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Payment-level failure while the order is still awaiting. The reservation
  // is still valid; the user can retry on the same order.
  // -------------------------------------------------------------------------

  if (payment?.status === 'failed') {
    return (
      <div className="space-y-4">
        <div className="card border-danger/40 bg-danger/5 p-6 text-center">
          <div className="text-lg font-semibold text-danger">Payment did not complete</div>
          <p className="mt-2 text-sm text-neutral-400">
            {payment.failureReason ?? 'The payment request was not approved.'}
          </p>
          <p className="mt-1 text-xs text-neutral-500">
            Your reservation is still held until it expires.
          </p>
          <Link to={`/checkout/${o.id}`} className="btn-primary mt-4 w-full">
            Try again
          </Link>
        </div>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Waiting state. Two phases:
  //   - First 30s: minimal "check your phone" instruction, no clutter.
  //   - After 30s: surface the "still waiting" panel with explicit actions.
  // Either way, a "Back to checkout" link is always visible at the bottom.
  // -------------------------------------------------------------------------

  const stillWaiting = elapsed > PATIENCE_MS;

  return (
    <div className="space-y-4">
      {/* Order summary + countdown, always visible so the user knows what is
          being paid for and how long the reservation is still held. */}
      <div className="card p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">Paying</div>
            <div className="mt-1 text-lg font-semibold">
              {formatMoney(o.totalMinor, o.currency)}
            </div>
            <div className="mt-0.5 text-xs text-neutral-500">Order {o.id.slice(0, 8)} · M-Pesa</div>
          </div>
          {o.expiresAt ? (
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wide text-neutral-500">
                Reservation
              </div>
              <div className="text-sm">
                <CountdownTimer expiresAt={o.expiresAt} />
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Primary waiting state */}
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="h-16 w-16 animate-spin rounded-full border-2 border-neutral-700 border-t-accent" />
        <h1 className="mt-6 text-lg font-semibold">Check your phone</h1>
        <p className="mt-2 max-w-xs text-sm text-neutral-400">
          We sent a payment request to your M-Pesa number. Enter your PIN to confirm.
        </p>
      </div>

      {/* After 30s, expose a manual refresh and a clear escape. */}
      {stillWaiting ? (
        <div className="card p-4 text-center">
          <div className="text-sm font-semibold">Still waiting?</div>
          <p className="mt-1 text-xs text-neutral-400">
            The prompt on your phone may have timed out. You can cancel this attempt and start a new
            payment, or wait for the reservation to expire on its own.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                // Force a fresh poll instead of waiting up to 2 more seconds.
                void order.refetch();
                startedAtRef.current = Date.now();
                setElapsed(0);
              }}
            >
              Refresh status
            </button>
            <Link to={`/checkout/${o.id}`} className="btn-primary">
              Back to checkout
            </Link>
          </div>
        </div>
      ) : null}

      {/* Always-available escape, so the user is never trapped. */}
      <div className="text-center">
        <Link
          to={`/checkout/${o.id}`}
          className="text-xs text-neutral-500 underline hover:text-neutral-300"
        >
          Cancel and return to checkout
        </Link>
      </div>
    </div>
  );
}
