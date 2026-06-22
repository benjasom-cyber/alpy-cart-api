/**
 * @file get-booking.js
 * @description Vercel API endpoint — retrieves a booking from Odin by reference or email.
 *
 * POST /api/get-booking
 *
 * Accepted body combinations (one required):
 *   Combo A: { bookingReference: string, customerName: string }
 *   Combo B: { customerEmail: string, customerLastName: string }
 *
 * Returns a flattened booking object with derived fields (rentalDays, personsCount, etc.)
 * or a 404 JSON error if no matching booking is found.
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
 * Flatten a raw Odin booking object into the standardised response shape.
 * @param {object} booking  Raw booking from Odin
 * @returns {object}
 */
function flattenBooking(booking) {
  const rentalFrom = toDateString(booking.rentalFrom);
  const rentalTo = toDateString(booking.rentalTo);
  const rentalDays = calcRentalDays(rentalFrom, rentalTo);

  const items = Array.isArray(booking.items) ? booking.items : [];
  // personsCount: try filtering equipment items first; fall back to all items
  const equipmentItems = items.filter(
    (i) => i?.type?.toLowerCase() === 'equipment' || i?.category?.toLowerCase() === 'equipment'
  );
  const personsCount = equipmentItems.length > 0 ? equipmentItems.length : items.length;

  const totalPrice =
    booking.totalPrice ??
    booking.price?.total ??
    null;

  return {
    found: true,
    bookingId: booking.id ?? null,
    bookingReference: booking.bookingReference ?? null,
    customerName: customerField(booking, 'name'),
    customerEmail: customerField(booking, 'email'),
    status: booking.status ?? null,
    shopName: booking.shop?.name ?? null,
    shopId: booking.shop?.id ?? null,
    shopSlug: booking.shop?.slug ?? null,
    shopCountry: booking.shop?.country ?? null,
    shopRegion: booking.shop?.region ?? null,
    rentalFrom,
    rentalTo,
    rentalDays,
    totalPrice: totalPrice !== null ? Number(totalPrice) : null,
    currency: booking.currency ?? null,
    personsCount,
    items,
    raw: booking,
  };
}

/**
 * Search Odin for bookings and return the raw bookings array.
 * @param {string} token  Bearer token
 * @param {URLSearchParams} params  Query parameters for the Odin search
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
  // Odin may return { data: [...] } or a bare array
  return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
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
    const token = await getOdinToken();
    let bookings = [];

    if (hasComboA) {
      // Combo A: look up by booking reference (should be unique)
      const params = new URLSearchParams({
        bookingReference: bookingReference.trim().toUpperCase(),
        limit: '1',
      });
      bookings = await odinSearch(token, params);
    } else {
      // Combo B: search by email + last name
      const params = new URLSearchParams({
        customerEmail: customerEmail.trim().toLowerCase(),
        customerName: customerLastName.trim(),
        limit: '5',
      });
      bookings = await odinSearch(token, params);

      // Prefer the booking whose customerName contains the supplied last name
      if (bookings.length > 1) {
        const needle = customerLastName.trim().toLowerCase();
        const match = bookings.find((b) => {
          const name = (customerField(b, 'name') || '').toLowerCase();
          return name.includes(needle);
        });
        if (match) bookings = [match];
        // else keep the first result (handled below)
      }
    }

    if (!bookings || bookings.length === 0) {
      res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({ found: false, error: 'No booking found for the provided details.' })
      );
    }

    const booking = bookings[0];
    const result = flattenBooking(booking);

    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[get-booking] Error:', err);
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Internal server error.', details: err.message }));
  }
}
