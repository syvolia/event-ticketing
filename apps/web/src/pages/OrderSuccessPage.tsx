import { Link, useParams } from 'react-router-dom';
import { useOrder, useTicketsForOrder } from '../hooks/queries.js';
import { TicketCard } from '../components/TicketCard.js';
import { Spinner } from '../components/Spinner.js';
import { formatMoney } from '../lib/format.js';

// The outbox issues tickets within a couple of seconds of `paid`. The success
// page polls at a fixed interval while mounted so the buyer always sees
// tickets, not an order with no code to show. The query stops refetching when
// the component unmounts (which happens as soon as the buyer navigates away),
// so a fixed interval here is intentional — it does not need to self-terminate.
const POLL_MS = 1_500;

export function OrderSuccessPage(): JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();
  const order = useOrder(orderId);
  const tickets = useTicketsForOrder(orderId, POLL_MS);

  if (!orderId) return <div className="card p-4 text-sm text-danger">Missing order id.</div>;
  if (order.isLoading) return <Spinner label="Loading your order…" />;
  if (order.isError || !order.data) {
    return <div className="card p-4 text-sm text-danger">Order not found.</div>;
  }

  const o = order.data;
  const expected = o.items.reduce((n, it) => n + it.quantity, 0);
  const have = tickets.data?.length ?? 0;
  const stillIssuing = have < expected;

  return (
    <div className="space-y-4">
      <div className="card border-accent/40 bg-accent/5 p-6 text-center">
        <div className="text-3xl">✓</div>
        <h1 className="mt-2 text-lg font-semibold">Payment received</h1>
        <p className="mt-1 text-sm text-neutral-400">
          {formatMoney(o.totalMinor, o.currency)} · order {o.id.slice(0, 8)}
        </p>
      </div>

      {stillIssuing ? (
        <div className="card p-4 text-center text-sm text-neutral-400">
          <Spinner label="Issuing your tickets…" />
        </div>
      ) : null}

      <div className="space-y-3">
        {tickets.data?.map((t) => (
          <TicketCard key={t.id} ticket={t} />
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Link to="/tickets" className="btn-secondary">
          All my tickets
        </Link>
        <Link to="/" className="btn-secondary">
          Home
        </Link>
      </div>
    </div>
  );
}
