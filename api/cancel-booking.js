/**
 * @file cancel-booking.js
 * @description Vercel API endpoint — cancels an Alpy booking via Odin.
 *
 * POST /api/cancel-booking
 *
 * Accepted body (one identifier combo required):
 *   { bookingId: string }                                           — direct UUID
 *   { bookingReference: string, customerName: string }             — Combo A
 *   { customerEmail: string, customerLastName: string }            — Combo B
 *
 * Optional:
 *   { reason: string }   — free-text cancellation reason
 *
 * Pre-flight checks before calling Odin cancel:
 *   1. Booking must not already be CANCELED or EXPIRED.
 *   2. rentalFrom must be in the future (> now).
 *
 * Cancellation strategy: tries POST /cancel first, falls back to DELETE.
 *
 * @author Alpy Support Team
 */

import { getOdinToken } from './odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/** Statuses that mean the booking is already finished / cancelled. */
const TERMINAL_STATUSES = ['CANCELED', 'CANCELLED', 'EXPIRED'];

// ---------------------------------------------------------------------------
// Helpers shared with get-booking logic (inlined to keep files self-contained)
// ---------------------------------------------------------------------------

/**
 * Safely extract a customer field that may be nested or flat on the booking.
 * @param {object} booking
 * @param {string} subKey  e.g. "name" or "email"
 * @returns {string|null}
 */
function customerField(booking, subKey) {
  return (
    booking?.customer?.[subKey] ||
    booking?.[`customer${subKey.charAt(0).toUpperCase()}${subKey.slice(1)}`] ||
    null
  );
}

/**
 * Search Odin for bookings and return the raw bookings array.
 * @param {string} token  Bearer token
 * @param {URLSearchParams} params  Query parameters
 * @returns {Promise<object[]>}
 */
async function odinSearch(token, params) {
  const url = `${ODIN_BASE}/api/v2/bookings?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odin search failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
}

/**
 * Resolve a booking object from the request body identifiers.
 * Returns the raw booking object, or throws/returns null on failure.
 * @param {string} token
 * @param {object} body  Parsed request body
 * @returns {Promise<{booking: object|null, error: string|null}>}
 */
async function resolveBooking(token, body) {
  const { bookingReference, customerName, customerEmail, customerLastName } = body;

  // If we already have a bookingId we still need the full object for pre-flight checks
  if (body.bookingId) {
    const res = await fetch(`${ODIN_BASE}/api/v2/bookings/${body.bookingId}`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      if (res.status === 404) return { booking: null, error: 'Booking not found.' };
      const text = await res.text();
      throw new Error(`Odin fetch failed (${res.status}): ${text}`);
    }
    const data = await res.json();
    // Odin may wrap in { data: ... }
    const booking = data?.data ?? data;
    return { booking, error: null };
  }

  const hasComboA = bookingReference && customerName;
  const hasComboB = customerEmail && customerLastName;

  if (!hasComboA && !hasComboB) {
    return {
      booking: null,
      error:
        'Provide bookingId, or (bookingReference + customerName), or (customerEmail + customerLastName).',
    };
  }

  let bookings = [];

  if (hasComboA) {
    const params = new URLSearchParams({
      bookingReference: bookingReference.trim().toUpperCase(),
      limit: '1',
    });
    bookings = await odinSearch(token, params);
  } else {
    const params = new URLSearchParams({
      customerEmail: customerEmail.trim().toLowerCase(),
      customerName: customerLastName.trim(),
      limit: '5',
    });
    bookings = await odinSearch(token, params);

    if (bookings.length > 1) {
      const needle = customerLastName.trim().toLowerCase();
      const match = bookings.find((b) => {
        const name = (customerField(b, 'name') || '').toLowerCase();
        return name.includes(needle);
      });
      if (match) bookings = [match];
    }
  }

  if (!bookings || bookings.length === 0) {
    return { booking: null, error: 'No booking found for the provided details.' };
  }

  return { booking: bookings[0], error: null };
}

/**
 * Attempt to cancel a booking via Odin.
 * Tries POST /cancel first; on 404/405 falls back to DELETE.
 * @param {string} token
 * @param {string} bookingId
 * @param {string|undefined} reason
 * @returns {Promise<{ok: boolean, status: number, body: object|string}>}
 */
async function callOdinCancel(token, bookingId, reason) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Strategy A: POST /api/v2/bookings/{id}/cancel
  const postRes = await fetch(`${ODIN_BASE}/api/v2/bookings/${bookingId}/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify(reason ? { reason } : {}),
  });

  if (postRes.ok) {
    let body;
    try { body = await postRes.json(); } catch { body = {}; }
    return { ok: true, status: postRes.status, body };
  }

  // Only fall back on 404 (endpoint doesn't exist) or 405 (method not allowed)
  if (postRes.status === 404 || postRes.status === 405) {
    // Strategy B: DELETE /api/v2/bookings/{id}
    const deleteRes = await fetch(`${ODIN_BASE}/api/v2/bookings/${bookingId}`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify(reason ? { reason } : {}),
    });

    let body;
    try { body = await deleteRes.json(); } catch { body = {}; }
    return { ok: deleteRes.ok, status: deleteRes.status, body };
  }

  // POST failed for another reason — surface that error
  let body;
  try { body = await postRes.json(); } catch { body = await postRes.text(); }
  return { ok: false, status: postRes.status, body };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Method guard
  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
  }

  const body = req.body || {};
  const { reason } = body;

  try {
    const token = await getOdinToken();

    // --- Step 1: Resolve the booking ---
    const { booking, error: resolveError } = await resolveBooking(token, body);

    if (resolveError || !booking) {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ success: false, error: resolveError || 'Booking not found.' })
      );
    }

    const bookingId = booking.id;
    const bookingReference = booking.bookingReference ?? null;
    const cName = customerField(booking, 'name');
    const status = (booking.status || '').toUpperCase();

    // --- Step 2: Guard — already cancelled/expired ---
    if (TERMINAL_STATUSES.includes(status)) {
      res.writeHead(409, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          success: false,
          error: 'Booking is already cancelled.',
          bookingReference,
          status: booking.status,
        })
      );
    }

    // --- Step 3: Guard — rental period has started ---
    const rentalFromRaw = booking.rentalFrom;
    if (rentalFromRaw) {
      const rentalStart = new Date(rentalFromRaw);
      if (!isNaN(rentalStart.getTime()) && rentalStart <= new Date()) {
        res.writeHead(409, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
        return res.end(
          JSON.stringify({
            success: false,
            error:
              'The rental period has already started — online cancellation is not possible.',
            bookingReference,
            rentalFrom: rentalFromRaw,
          })
        );
      }
    }

    // --- Step 4: Call Odin to cancel ---
    const cancelResult = await callOdinCancel(token, bookingId, reason);

    if (!cancelResult.ok) {
      const details =
        typeof cancelResult.body === 'string'
          ? cancelResult.body
          : JSON.stringify(cancelResult.body);

      res.writeHead(502, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          success: false,
          error: 'Odin returned an error when attempting cancellation.',
          odinStatus: cancelResult.status,
          details,
        })
      );
    }

    // --- Step 5: Build success response ---
    const odinBody = typeof cancelResult.body === 'object' ? cancelResult.body : {};
    const refundInfo =
      odinBody.refund?.message ||
      odinBody.refundInfo ||
      odinBody.refund?.amount !== undefined
        ? `Refund amount: ${odinBody.refund?.amount} ${odinBody.refund?.currency || booking.currency || ''}`
        : undefined;

    const cancelledAt = odinBody.cancelledAt || odinBody.canceledAt || new Date().toISOString();

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        success: true,
        bookingReference,
        customerName: cName,
        message: `Booking ${bookingReference || bookingId} has been successfully cancelled.`,
        ...(refundInfo ? { refundInfo } : {}),
        cancelledAt,
      })
    );
  } catch (err) {
    console.error('[cancel-booking] Error:', err);
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Internal server error.', details: err.message }));
  }
}
