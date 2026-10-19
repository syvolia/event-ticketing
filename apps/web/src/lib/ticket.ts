// Client-side token *parsing* (not verification).
//
// We cannot verify the HMAC offline — the secret is server-only, and shipping
// it would let anyone mint tickets. What we can do offline is check the token
// has the right shape, uses a kid we trust, refers to an event we're scanning,
// and contains a ticket id present in our cached manifest. Real cryptographic
// verification happens when the scan syncs.
//
// This gives offline scanning its necessary property — no false negatives for
// legitimate tickets — while making it impossible for a random QR to reach an
// "accepted" state. A forged QR would still be caught at sync time.

export interface ParsedToken {
  version: 'v1';
  kid: string;
  ticketId: string;
  eventId: string;
}

export function parseTicketToken(token: string): ParsedToken | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, kid, payloadB64] = parts as [string, string, string, string];
  if (version !== 'v1') return null;
  if (!kid || kid.length > 100) return null;
  try {
    const json = atobUrl(payloadB64);
    const parsed = JSON.parse(json) as { t?: unknown; e?: unknown; v?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.e !== 'string' || parsed.v !== 1) {
      return null;
    }
    return { version: 'v1', kid, ticketId: parsed.t, eventId: parsed.e };
  } catch {
    return null;
  }
}

function atobUrl(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return atob(padded);
}