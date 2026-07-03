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
 * Real Odin /api/v2/booking/{ref} response shape (confirmed live 2026-07-03):
 *   { bookingReference, id, bookingStatus, rentalPeriod: {from, to, durationInDays},
 *     shop: {id, coreId, name, address}, basePrice: {amount, currency} (in cents),
 *     discount, onlinePayment, total: {amount, currency} (remaining balance, in cents),
 *     customer: {name, email, country, phone}, equipment: [...] }
 *
 * @author Alpy Support Team
 */

const ODIN_BASE = 'https://odin.alpy.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

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

function calcRentalDays(from, to) {
  if (!from || !to) return null;
  const msPerDay = 1000 * 60 * 60 * 24;
  const diff = new Date(to) - new Date(from);
  if (isNaN(diff)) return null;
  return Math.round(diff / msPerDay) + 1;
}

function customerField(booking, subKey) {
  return (
    booking?.customer?.[subKey] ||
    booking?.[`customer${subKey.charAt(0).toUpperCase()}${subKey.slice(1)}`] ||
    null
  );
}

function flattenBooking(booking) {
  const rentalFrom = toDateString(booking.rentalPeriod?.from ?? booking.rentalFrom);
  const rentalTo = toDateString(booking.rentalPeriod?.to ?? booking.rentalTo);
  const rentalDays =
    booking.rentalPeriod?.durationInDays ?? calcRentalDays(rentalFrom, rentalTo);

  const items = Array.isArray(booking.items)
    ? booking.items
    : Array.isArray(booking.equipment)
    ? booking.equipment
    : [];
  const equipmentItems = items.filter(
    (i) => i?.type?.toLowerCase() === 'equipment' || i?.category?.toLowerCase() === 'equipment'
  );
  const personsCount = equipmentItems.length > 0 ? equipmentItems.length : items.length;

  // Odin amounts (basePrice / total / price) are in cents.
  const moneyObj =
    booking.basePrice ?? booking.total ?? booking.price ?? booking.pricing ?? null;
  const totalPrice =
    moneyObj && moneyObj.amount != null
      ? moneyObj.amount / 100
      : booking.totalPrice ?? booking.grandTotal ?? null;
  const currency = moneyObj?.currency ?? booking.currency ?? null;

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
    currency,
    personsCount,
    items,
    raw: booking,
  };
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

  const { bookingReference, customerName, customerEmail, customerLastName } = req.body || {};

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
