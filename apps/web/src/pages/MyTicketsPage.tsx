import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMyTickets } from '../hooks/queries.js';
import { TicketCard } from '../components/TicketCard.js';
import { Spinner } from '../components/Spinner.js';
import { getToken } from '../lib/api.js';

export function MyTicketsPage(): JSX.Element {
  const navigate = useNavigate();
  const tickets = useMyTickets();

  useEffect(() => {
    if (!getToken()) {
      navigate(`/login?returnTo=${encodeURIComponent('/tickets')}`);
    }
  }, [navigate]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">My tickets</h1>

      {tickets.isLoading ? <Spinner label="Loading…" /> : null}

      {tickets.isError ? (
        <div className="card p-4 text-sm text-danger">Could not load your tickets.</div>
      ) : null}

      {tickets.data && tickets.data.length === 0 ? (
        <div className="card p-6 text-center text-sm text-neutral-500">
          You have no tickets yet.{' '}
          <Link to="/" className="text-accent underline">
            Browse events
          </Link>
          .
        </div>
      ) : null}

      <div className="space-y-3">
        {tickets.data?.map((t) => (
          <TicketCard key={t.id} ticket={t} />
        ))}
      </div>
    </div>
  );
}
