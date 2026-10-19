import type { TicketView } from '@ticketing/shared';
import QRCode from 'react-qr-code';
import { formatDateTime } from '../lib/format.js';

export function TicketCard({ ticket }: { ticket: TicketView }): JSX.Element {
  const voided = ticket.status === 'void';
  const checkedIn = ticket.status === 'checked_in';

  return (
    <div className={`card overflow-hidden ${voided ? 'opacity-60' : ''}`}>
      <div className="border-b border-edge px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold">{ticket.eventName}</h3>
            <p className="mt-0.5 text-xs text-neutral-500">
              {formatDateTime(ticket.eventStartsAt)} · {ticket.tierName}
            </p>
          </div>
          {voided ? (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-danger">
              Void
            </span>
          ) : checkedIn ? (
            <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-warn">
              Used
            </span>
          ) : (
            <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-accent">
              Valid
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-4 p-4">
        <div className="rounded-lg bg-white p-2">
          {/* The payload is a signed token from the API. Rendering it
              client-side keeps the QR faithful to what the server issued,
              without an extra round trip. */}
          <QRCode value={ticket.qrPayload} size={112} level="M" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="label">Code</div>
          <div className="font-mono text-xl tracking-wider">{ticket.shortCode}</div>
          <p className="mt-2 text-xs text-neutral-500">Show this at the door. Do not share.</p>
        </div>
      </div>
    </div>
  );
}
