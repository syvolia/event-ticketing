// All buyer-flow queries and mutations in one place. Kept together so the
// polling intervals and query keys are easy to audit at a glance — polling
// is where money and inventory correctness surface on the client.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EventDetail,
  OrderView,
  PaymentView,
  TicketView,
} from '@ticketing/shared';
import { api, ApiError } from '../lib/api.js';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function useEvents() {
  return useQuery({
    queryKey: ['events'],
    queryFn: () => api<{ events: EventDetail[] }>('/events').then((r) => r.events),
    staleTime: 30_000,
  });
}

export function useEvent(id: string | undefined) {
  return useQuery({
    queryKey: ['event', id],
    queryFn: () => api<{ event: EventDetail }>(`/events/${id}`).then((r) => r.event),
    enabled: Boolean(id),
    // Live availability. 10s is the trade-off: fast enough that a user
    // watching the page does not see stale stock, slow enough that a room
    // full of buyers does not hammer the API.
    refetchInterval: 10_000,
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function useOrder(id: string | undefined, opts: { pollMs?: number | false } = {}) {
  return useQuery({
    queryKey: ['order', id],
    queryFn: () => api<{ order: OrderView }>(`/orders/${id}`).then((r) => r.order),
    enabled: Boolean(id),
    refetchInterval: opts.pollMs === undefined ? false : opts.pollMs,
  });
}

export function useCreateOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      eventId: string;
      items: Array<{ tierId: string; quantity: number }>;
      idempotencyKey: string;
    }) =>
      api<{ order: OrderView }>('/orders', {
        method: 'POST',
        json: { eventId: input.eventId, items: input.items },
        headers: { 'idempotency-key': input.idempotencyKey },
      }).then((r) => r.order),
    onSuccess: (order) => {
      // Availability changed on the server. Refresh the event detail so the
      // tier picker reflects the reservation we just made.
      void qc.invalidateQueries({ queryKey: ['event', order.eventId] });
    },
  });
}

export function useStartPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      orderId: string;
      phone: string;
      idempotencyKey: string;
    }) =>
      api<{ payment: PaymentView }>(`/orders/${input.orderId}/pay`, {
        method: 'POST',
        json: { provider: 'mpesa', phone: input.phone },
        headers: { 'idempotency-key': input.idempotencyKey },
      }).then((r) => r.payment),
    onSuccess: (_payment, vars) => {
      void qc.invalidateQueries({ queryKey: ['order', vars.orderId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

export function useMyTickets() {
  return useQuery({
    queryKey: ['tickets'],
    queryFn: () => api<{ tickets: TicketView[] }>('/tickets').then((r) => r.tickets),
  });
}

// Narrow query keyed by order so the success page can poll for tickets that
// the outbox worker is still issuing. Returns [] until the tickets exist.
export function useTicketsForOrder(orderId: string | undefined, pollMs: number | false = false) {
  return useQuery({
    queryKey: ['tickets', 'order', orderId],
    queryFn: () =>
      api<{ tickets: TicketView[] }>('/tickets').then((r) =>
        r.tickets.filter((t) => t.orderId === orderId),
      ),
    enabled: Boolean(orderId),
    refetchInterval: pollMs,
  });
}

// Re-export for callers that want to type-narrow on our error class.
export { ApiError };