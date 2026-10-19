import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { checkoutFormSchema, type CheckoutForm } from '@ticketing/shared';
import { useOrder, useStartPayment } from '../hooks/queries.js';
import { CountdownTimer } from '../components/CountdownTimer.js';
import { Spinner } from '../components/Spinner.js';
import { formatMoney } from '../lib/format.js';
import { ApiError, getToken } from '../lib/api.js';

export function CheckoutPage(): JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();

  // Poll the order while we are on this page. The reservation can expire
  // underneath us — if the sweeper fires, or the user leaves the tab open,
  // we want the UI to reflect that within a few seconds.
  const order = useOrder(orderId, { pollMs: 5_000 });
  const startPayment = useStartPayment();
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One payment idempotency key per checkout attempt. Persisted across the
  // whole page lifetime in a ref — if the user retries after a failure, the
  // server sees the same key and returns the same payment row.
  const payKeyRef = useRef<string>(`pay_${crypto.randomUUID()}`);

  // If the user is not logged in, bounce to login. The order might still be
  // valid — we set a returnTo so after sign-in they land back here.
  useEffect(() => {
    if (!getToken()) {
      navigate(`/login?returnTo=${encodeURIComponent(`/checkout/${orderId ?? ''}`)}`);
    }
  }, [navigate, orderId]);

  const form = useForm<CheckoutForm>({
    resolver: zodResolver(checkoutFormSchema),
    defaultValues: { phone: '' },
    mode: 'onChange',
  });

  useEffect(() => {
    if (order.data && (order.data.status === 'expired' || order.data.status === 'failed')) {
      setExpired(true);
    }
  }, [order.data]);

  if (!orderId) return <div className="card p-4 text-sm text-danger">Missing order id.</div>;
  if (order.isLoading) return <Spinner label="Loading order…" />;
  if (order.isError || !order.data) {
    return <div className="card p-4 text-sm text-danger">Order not found.</div>;
  }

  const o = order.data;
  const alreadyPaid = o.status === 'paid' || o.status === 'fulfilled';

  // If we somehow arrive here after payment, send the user forward instead of
  // showing the pay form again.
  if (alreadyPaid) {
    navigate(`/orders/${o.id}/success`, { replace: true });
    return <Spinner />;
  }

  async function onSubmit(values: CheckoutForm): Promise<void> {
    setError(null);
    if (!orderId) return;
    try {
      await startPayment.mutateAsync({
        orderId,
        phone: values.phone,
        idempotencyKey: payKeyRef.current,
      });
      navigate(`/payment/${orderId}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('This order already has a payment in progress. Please wait.');
      } else {
        setError((err as Error).message);
      }
    }
  }

  const expiredView =
    expired || (o.expiresAt !== null && new Date(o.expiresAt).getTime() <= Date.now());

  return (
    <div className="space-y-4">
      <Link to={`/events/${o.eventId}`} className="text-xs text-neutral-500 hover:text-neutral-300">
        ← Back to event
      </Link>

      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs uppercase tracking-wide text-neutral-500">Reservation</div>
          {o.expiresAt ? (
            <div className="text-xs text-neutral-500">
              expires in{' '}
              <CountdownTimer expiresAt={o.expiresAt} onExpired={() => setExpired(true)} />
            </div>
          ) : null}
        </div>
        <div className="mt-3 space-y-2">
          {o.items.map((it) => (
            <div key={it.tierId} className="flex items-baseline justify-between text-sm">
              <span className="text-neutral-300">
                {it.tierName} <span className="text-neutral-600">× {it.quantity}</span>
              </span>
              <span className="font-mono">{formatMoney(it.lineTotalMinor, it.currency)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-baseline justify-between border-t border-edge pt-3">
          <span className="text-sm text-neutral-500">Total</span>
          <span className="text-lg font-semibold">{formatMoney(o.totalMinor, o.currency)}</span>
        </div>
      </div>

      {expiredView ? (
        <div className="card border-warn/40 bg-warn/5 p-4">
          <div className="text-sm font-semibold text-warn">Reservation expired</div>
          <p className="mt-1 text-xs text-neutral-400">
            The hold on these tickets has been released. Nothing was charged.
          </p>
          <Link to={`/events/${o.eventId}`} className="btn-primary mt-3 w-full">
            Start over
          </Link>
        </div>
      ) : (
        <form className="card p-4 space-y-3" onSubmit={form.handleSubmit(onSubmit)}>
          <div>
            <label className="label" htmlFor="phone">
              Phone number (M-Pesa)
            </label>
            <input
              id="phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder="+254712345678"
              className="input font-mono"
              {...form.register('phone')}
            />
            {form.formState.errors.phone ? (
              <p className="mt-1 text-xs text-danger">{form.formState.errors.phone.message}</p>
            ) : null}
          </div>

          {error ? (
            <div className="rounded-lg bg-danger/10 p-3 text-xs text-danger">{error}</div>
          ) : null}

          <button
            type="submit"
            className="btn-primary w-full"
            disabled={
              form.formState.isSubmitting || startPayment.isPending || !form.formState.isValid
            }
          >
            {startPayment.isPending
              ? 'Sending STK push…'
              : `Pay ${formatMoney(o.totalMinor, o.currency)}`}
          </button>
          <p className="text-center text-[11px] text-neutral-600">
            You will receive a prompt on your phone. Enter your M-Pesa PIN to complete.
          </p>
        </form>
      )}
    </div>
  );
}
