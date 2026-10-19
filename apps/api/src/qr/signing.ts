// QR token format: v1.<kid>.<base64url(json payload)>.<base64url(hmac)>
//
// - v1 is a schema version. If we ever change the payload shape (add a field,
//   change the JSON keys), we bump to v2 and support both during a transition.
// - kid selects the signing key at verify time. Multiple keys can be active
//   for verification (for rotation), but only one is used to sign new tokens.
// - The signature covers "v1.<kid>.<payload>", so tampering with the version,
//   the kid, or the payload invalidates the token.
// - HMAC-SHA256, not Ed25519, because only our own server verifies tokens. If
//   we ever want a third party to verify without sharing the signing secret,
//   we would swap to Ed25519 and the format would stay identical (the secret
//   becomes a private key, verification uses the public half).

import { createHmac, timingSafeEqual } from 'node:crypto';

export const QR_VERSION = 'v1';

export interface QrTokenPayload {
  /** ticketId — the row's primary key. */
  t: string;
  /** eventId — lets a scanner reject cross-event tickets without a DB lookup. */
  e: string;
  /** schema version — matches the outer version prefix. */
  v: 1;
}

export function signTicketPayload(
  payload: QrTokenPayload,
  kid: string,
  secret: Buffer,
): string {
  const json = JSON.stringify(payload);
  const body = `${QR_VERSION}.${kid}.${b64urlEncode(json)}`;
  const sig = createHmac('sha256', secret).update(body).digest();
  return `${body}.${b64urlEncode(sig)}`;
}

export interface VerifyResult {
  payload: QrTokenPayload;
  kid: string;
}

/**
 * Verify a QR token. Returns null for any failure — malformed, unknown kid,
 * bad signature, invalid JSON, missing fields. The caller treats null as
 * "invalid ticket".
 *
 * Constant-time compare on the HMAC prevents an attacker from learning the
 * signature byte-by-byte via timing.
 */
export function verifyTicketToken(
  token: string,
  keysByKid: ReadonlyMap<string, Buffer>,
): VerifyResult | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, kid, payloadB64, sigB64] = parts as [string, string, string, string];
  if (version !== QR_VERSION) return null;

  const secret = keysByKid.get(kid);
  if (!secret) return null;

  const body = `${version}.${kid}.${payloadB64}`;
  const expected = createHmac('sha256', secret).update(body).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(sigB64);
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  if (!timingSafeEqual(expected, actual)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as { t?: unknown }).t !== 'string' ||
    typeof (payload as { e?: unknown }).e !== 'string' ||
    (payload as { v?: unknown }).v !== 1
  ) {
    return null;
  }
  return { payload: payload as QrTokenPayload, kid };
}

// --- base64url helpers ----------------------------------------------------

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64');
}