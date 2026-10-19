// 50 concurrent scans of the same QR. Two online devices race; or one device
// double-fires. Only one scan may win the state transition. Every other
// request must observe the winner and report `duplicate`.
//
// The atomicity is in the `UPDATE tickets ... WHERE status='valid' OR
// checked_in_at > $new` statement under a row lock — see services/checkin.ts.
import { beforeEach, describe, expect, it } from 'vitest';
import { issuePaidOrder, setupBurstContext, type ConcurrencyContext } from './helpers.js';
import { checkInvariants } from './invariants.js';
import { pool } from '../../src/db/pool.js';

describe('concurrency — check-in race', () => {
  let ctx: ConcurrencyContext;

  beforeEach(async () => {
    ctx = await setupBurstContext({ capacity: 5 });
  });

  it('50 concurrent scans of the same QR: exactly one accepted', async () => {
    const { orderId, qrPayloads } = await issuePaidOrder(
      ctx.app,
      ctx.buyerToken,
      ctx.eventId,
      ctx.tierId,
      1,
    );
    expect(qrPayloads).toHaveLength(1);
    const qr = qrPayloads[0]!;

    const scannedAt = new Date().toISOString();
    const deviceId = 'device-race';
    const N = 50;

    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        ctx.app.inject({
          method: 'POST',
          url: '/checkin',
          headers: { authorization: `Bearer ${ctx.staffToken}` },
          payload: {
            clientScanId: `race-scan-${i}-${Date.now()}`,
            token: qr,
            deviceId,
            scannedAt,
            eventId: ctx.eventId,
          },
        }),
      ),
    );

    // The API returns 200 for every scan; the outcome is in the body.
    for (const r of responses) expect(r.statusCode).toBe(200);

    const outcomes = responses.map((r) => r.json().outcome as string);
    const accepted = outcomes.filter((o) => o === 'accepted').length;
    const duplicate = outcomes.filter((o) => o === 'duplicate').length;
    const other = outcomes.filter((o) => o !== 'accepted' && o !== 'duplicate');

    expect(other, `unexpected outcomes: ${JSON.stringify(other.slice(0, 3))}`).toEqual([]);
    expect(accepted).toBe(1);
    expect(duplicate).toBe(N - 1);

    // The DB reflects exactly one check-in.
    const { rows: t } = await pool.query<{ status: string; checked_in_at: Date | null }>(
      `SELECT status, checked_in_at FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    expect(t[0]!.status).toBe('checked_in');
    expect(t[0]!.checked_in_at).not.toBeNull();

    // Exactly N scan_attempts rows for this device — one per input, none lost.
    const { rows: sa } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM scan_attempts WHERE device_id = $1`,
      [deviceId],
    );
    expect(sa[0]!.n).toBe(N);

    // Exactly one of them has outcome='accepted'.
    const { rows: acc } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM scan_attempts WHERE device_id = $1 AND outcome = 'accepted'`,
      [deviceId],
    );
    expect(acc[0]!.n).toBe(1);

    await checkInvariants();
  });

  it('two devices racing on the same QR offline: earliest scannedAt wins', async () => {
    const { orderId, qrPayloads } = await issuePaidOrder(
      ctx.app,
      ctx.buyerToken,
      ctx.eventId,
      ctx.tierId,
      1,
    );
    const qr = qrPayloads[0]!;

    // Device B's scan happens LATER in wall-clock time but is DELIVERED first.
    // Device A's scan happens EARLIER but is DELIVERED second. The winner must
    // be A, by timestamp, regardless of arrival order.
    const tEarly = new Date(Date.now() - 60_000).toISOString();
    const tLate = new Date(Date.now() - 30_000).toISOString();

    await ctx.app.inject({
      method: 'POST',
      url: '/checkin/sync',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: {
        scans: [
          {
            clientScanId: `devB-${Date.now()}`,
            token: qr,
            deviceId: 'device-B',
            scannedAt: tLate,
            gate: 'B',
            eventId: ctx.eventId,
          },
        ],
      },
    });

    // Device A delivers its earlier scan.
    const aRes = await ctx.app.inject({
      method: 'POST',
      url: '/checkin/sync',
      headers: { authorization: `Bearer ${ctx.staffToken}` },
      payload: {
        scans: [
          {
            clientScanId: `devA-${Date.now()}`,
            token: qr,
            deviceId: 'device-A',
            scannedAt: tEarly,
            gate: 'A',
            eventId: ctx.eventId,
          },
        ],
      },
    });
    expect(aRes.statusCode).toBe(200);
    expect(aRes.json().results[0].outcome).toBe('accepted');

    const { rows } = await pool.query<{
      checked_in_at: Date;
      checked_in_device_id: string;
      checked_in_gate: string;
      status: string;
    }>(
      `SELECT checked_in_at, checked_in_device_id, checked_in_gate, status FROM tickets WHERE order_id = $1`,
      [orderId],
    );
    expect(rows[0]!.status).toBe('checked_in');
    expect(rows[0]!.checked_in_device_id).toBe('device-A');
    expect(rows[0]!.checked_in_gate).toBe('A');
    expect(rows[0]!.checked_in_at.toISOString()).toBe(tEarly);

    await checkInvariants();
  });
});