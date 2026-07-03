/**
 * @file get-booking.js
 * @description Vercel API endpoint — retrieves a booking from Odin by reference or email.
 *
 * POST /api/get-booking
 *
 * Accepted body combinations (one required):
 * Combo A: { bookingReference: string, customerName: string }
 * Combo B: { customerEmail: string, customerLastName: string }
 *
 * Returns a flattened booking object with derived fields (rentalDays, personsCount, etc.)
 * or a 404 JSON error if no matching booking is found.
 *
 * NOTE (2026-07-03): Odin's REST API has no working OAuth / client_credentials
 * integration for server-to-server calls — confirmed live: POST /oauth/token
 * rejects our client with 401 invalid_client ("Client authentication failed"),
 * and Odin has no documented login/OAuth endpoint at all. The only
 * proven-working, unauthenticated path — used successfully in production by
 * the SKIBOT ZAF app (see ODIN_INFRASTRUCTURE.md) — is:
 *   - GET  /api/v2/booking/{ref}   (public, lookup by reference) OK
 *   - POST /api/v2/customer        (public route, but Odin requires a
 *     customer JWT server-side to actually return data for this one —
 *     known limitation, kept here as best-effort only, same as the ZAF app)
 * This file now calls those endpoints directly instead of going through
 * getOdinToken() / odin-auth.js.
 *
 * @author Alpy Support Team
 */

const ODIN_BASE = 'https://odin.alpy.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Parse an ISO datetime string (or date string) to a YYYY-MM-DD string.
 * Returns null if the value is falsy or unparseable.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function toDateString(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  } catch {
    return null;
  }
}

/**
 * Calculate the number of rental days between two YYYY-MM-DD strings (inclusive).
 * Returns null if either date is missing.
 * @param {string|null} from
 * @param {string|null} to
 * @returns {number|null}
 */
function calcRentalDays(from, to) {
  if (!from || !to) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const diff = new Date(to) - new Date(from);
  if (isNaN(diff)) return null;
  return Math.round(diff / msPerDay) + 1; // inclusive of both start and end
}

/**
 * Safely extract a field that might live under booking.customer.X or booking.customerX.
 * @param {object} booking
 * @param {string} subKey e.g. "name" or "email"
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
 * Flatten a raw Odin booking object into the standardised response shape.
 * Reads both the real Odin field names (bookingStatus, rentalPeriod.from/to)
 * and the older flat names as a fallback, in case the shape varies.
 * @param {object} booking Raw booking from Odin
 * @returns {object}
 */
function flattenBooking(booking) {
  const rentalFrom = toDateString(booking.rentalPeriod?.from ?? booking.rentalFrom);
  const rentalTo = toDateString(booking.rentalPeriod?.to ?? booking.rentalTo);
  const rentalDays =
    booking.rentalPeriod?.durationInDays ?? calcRentalDays(rentalFrom, rentalTo);

  const items = Array.isArray(booking.items) ? booking.items : [];
  // personsCount: try filtering equipment items first; fall back to all items
  const equipmentItems = items.filter(
    (i) => i?.type?.toLowerCase() === 'equipment' || i?.category?.toLowerCase() === 'equipment'
  );
  const personsCount = equipmentItems.length > 0 ? equipmentItems.length : items.length;

  const totalPrice =
    booking.totalPrice ??
    booking.price?.total ??
    booking.pricing?.total ??
    booking.grandTotal ??
    null;

  return {
    found: true,
    bookingId: booking.id ?? null,
    bookingReference: booking.bookingReference ?? null,
    customerName: customerField(booking, 'name'),
    customerEmail: customerField(booking, 'email'),
    status: booking.bookingStatus ?? booking.status ?? null,
    shopName: booking.shop?.name ?? null,
    shopId: booking.shop?.id ?? null,
    shopSlug: booking.shop?.slug ?? null,
    shopCountry: booking.shop?.country ?? null,
    shopRegion: booking.shop?.region ?? null,
    rentalFrom,
    rentalTo,
    rentalDays,
    totalPrice: totalPrice !== null ? Number(totalPrice) : null,
    currency: booking.currency ?? booking.price?.currency ?? null,
    personsCount,
    items,
    raw: booking,
  };
}

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

  const { bookingReference, customerName, customerEmail, customerLastName } = req.body || {};

  // Determine which combo to use
  const hasComboA = bookingReference && customerName;
  const hasComboB = customerEmail && customerLastName;

  if (!hasComboA && !hasComboB) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({
        error:
          'Provide either (bookingReference + customerName) or (customerEmail + customerLastName).',
      })
    );
  }

  try {
    let booking = null;

    if (hasComboA) {
      // Combo A: public endpoint, no auth needed — proven working pattern
      // (same one used successfully by the SKIBOT ZAF app's own get-booking.js).
      const ref = bookingReference.trim().toUpperCase();
      const r = await fetch(`${ODIN_BASE}/api/v2/booking/${encodeURIComponent(ref)}`, {
        headers: { Accept: 'application/json' },
      });
      if (r.ok) {
        booking = await r.json().catch(() => null);
      } else if (r.status !== 404) {
        const body = await r.text();
        throw new Error(`Odin booking lookup failed (${r.status}): ${body.slice(0, 200)}`);
      }
    } else {
      // Combo B: best-effort by email. Odin's /api/v2/customer route requires
      // a customer JWT to actually return data server-side (known limitation,
      // documented in ODIN_INFRASTRUCTURE.md) — kept here for parity with the
      // ZAF app, but may legitimately 401 until Odin exposes an admin-scoped
      // search endpoint.
      const r = await fetch(`${ODIN_BASE}/api/v2/customer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: customerEmail.trim().toLowerCase() }),
      });
      const text = await r.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }

      if (!r.ok) {
        console.error('[get-booking] Odin /api/v2/customer', r.status, text.slice(0, 200));
      } else {
        let bookings = [];
        if (Array.isArray(body)) bookings = body;
        else if (Array.isArray(body.bookings)) bookings = body.bookings;
        else if (Array.isArray(body.data)) bookings = body.data;
        else if (body.bookingReference) bookings = [body];

        const needle = customerLastName.trim().toLowerCase();
        const match = bookings.find((b) => {
          const name = (customerField(b, 'name') || '').toLowerCase();
          return name.includes(needle);
        });
        booking = match || bookings[0] || null;
      }
    }

    if (!booking) {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ found: false, error: 'No booking found for the provided details.' })
      );
    }

    const result = flattenBooking(booking);
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[get-booking] Error:', err);
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Internal server error.', details: err.message }));
  }
}
