/**
 * @file cancel-booking.js
 * @description Vercel API endpoint — cancels an Alpy booking via Odin's webhook.
 *
 * POST /api/cancel-booking
 *
 * Accepted body (from the Zendesk "cancel_booking" custom action):
 * { bookingReference, customerName, customerEmail, customerLastName, reason }
 * Only bookingReference is strictly required — customerEmail is resolved
 * automatically from the booking record if not supplied.
 *
 * NOTE (2026-07-03): mirrors the proven-working pattern used in production by
 * the SKIBOT ZAF app (see ODIN_INFRASTRUCTURE.md / api/cancel-booking.js) — a
 * direct POST to Odin's webhook with a static X-Webhook-Secret, NOT the
 * broken OAuth/client_credentials flow the old version of this file used
 * (see get-booking.js notes for why that never worked: no valid Odin OAuth
 * endpoint exists for server-to-server calls).
 *
 * If bookingReference is given without a known email, this first resolves
 * the booking via the public, unauthenticated GET /api/v2/booking/{ref}
 * endpoint to find the customer's real email and to check the booking isn't
 * already cancelled.
 *
 * @author Alpy Support Team
 */

const ODIN_BASE = 'https://odin.alpy.com';
const WEBHOOK_SECRET = 's6Xubrfc46ZZ8JHvQiYn';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const TERMINAL_STATUSES = ['CANCELED', 'CANCELLED', 'EXPIRED'];

function customerField(booking, subKey) {
  return (
    booking?.customer?.[subKey] ||
    booking?.[`customer${subKey.charAt(0).toUpperCase()}${subKey.slice(1)}`] ||
    null
  );
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return {};
}

async function lookupBookingByRef(ref) {
  const r = await fetch(`${ODIN_BASE}/api/v2/booking/${encodeURIComponent(ref)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// Fetch Odin without ever throwing — returns a structured result.
// Odin returns an empty body on success, so never call r.json() directly.
async function odinFetch(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (netErr) {
    return { ok: false, status: 0, networkError: netErr.message, raw: '', parsed: null };
  }
  let raw = '';
  try { raw = await response.text(); } catch (_) {}
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) {}
  return { ok: response.ok, status: response.status, networkError: null, raw, parsed };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
  }

  const body = parseBody(req);
  const { bookingReference, reason } = body;
  let customerEmail = body.customerEmail;

  if (!bookingReference) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Missing bookingReference.' }));
  }

  try {
    // Resolve the booking to confirm it exists, find the customer's real
    // email if we don't already have one, and guard against double-cancel.
    const booking = await lookupBookingByRef(bookingReference.trim().toUpperCase());

    if (!booking) {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ success: false, error: 'No booking found for that reference.' })
      );
    }

    const status = (booking.bookingStatus || booking.status || '').toUpperCase();
    if (TERMINAL_STATUSES.includes(status)) {
      res.writeHead(409, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          success: false,
          error: 'Booking is already cancelled.',
          bookingreference: booking.bookingReference,
          status,
        })
      );
    }

    if (!customerEmail) {
      customerEmail = customerField(booking, 'email');
    }
    if (!customerEmail) {
      res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ success: false, error: 'Could not determine the customer email for this booking.' })
      );
    }

    const resolvedRef = booking.bookingReference || bookingReference.trim().toUpperCase();
    const payload = {
      customerEmail,
      bookingReference: resolvedRef,
      reference: 'https://skisupport.zendesk.com',
      ...(reason ? { reason } : {}),
    };

    console.log('[cancel-booking] ->', JSON.stringify(payload));

    const result = await odinFetch(`${ODIN_BASE}/webhook/booking-cancellation`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
      body: JSON.stringify(payload),
    });

    console.log('[cancel-booking] odin status:', result.status,
      '| network error:', result.networkError || 'none',
      '| raw:', result.raw.slice(0, 400));

    if (result.networkError) {
      res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Failed to reach Odin', details: result.networkError }));
    }

    if (!result.ok) {
      const snippet = result.raw.slice(0, 300);
      res.writeHead(result.status || 502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          success: false,
          error: 'Odin rejected the cancellation.',
          odinStatus: result.status,
          odinMessage: result.parsed || snippet,
        })
      );
    }

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        success: true,
        bookingreference: resolvedRef,
        message: `Booking ${resolvedRef} has been successfully cancelled.`,
        cancelledat: new Date().toISOString(),
        ...(result.parsed || {}),
      })
    );
  } catch (err) {
    console.error('[cancel-booking] Error:', err);
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, error: 'Internal server error.', details: err.message }));
  }
}
