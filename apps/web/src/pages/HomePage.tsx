import { useEvents } from '../hooks/queries.js';
import { EventCard } from '../components/EventCard.js';
import { Spinner } from '../components/Spinner.js';

export function HomePage(): JSX.Element {
  const events = useEvents();

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Events</h1>
        <p className="text-sm text-neutral-500">Pick something to attend.</p>
      </div>

      {events.isLoading ? <Spinner label="Loading events…" /> : null}

      {events.isError ? (
        <div className="card p-4 text-sm text-danger">
          Could not load events. Pull to refresh or try again later.
        </div>
      ) : null}

      {events.data && events.data.length === 0 ? (
        <div className="card p-6 text-center text-sm text-neutral-500">
          No events are on sale right now.
        </div>
      ) : null}

      <div className="space-y-3">
        {events.data?.map((e) => (
          <EventCard key={e.id} event={e} />
        ))}
      </div>
    </div>
  );
}
