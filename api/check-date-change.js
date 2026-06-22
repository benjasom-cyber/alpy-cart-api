/**
 * POST /api/check-date-change
 *
 * Checks whether a rental date change is allowed for a booking.
 *
 * Body params (booking lookup — one combo required):
 *   Combo A: { bookingReference, customerName }
 *   Combo B: { customerEmail, customerLastName }
 *   Combo C: { bookingId }   — direct UUID lookup
 *
 * Required:
 *   newStartDate  YYYY-MM-DD
 *   newEndDate    YYYY-MM-DD
 *
 * Business rules:
 *   1. Deadline: must request before rental start day at 08:00 Europe/Paris
 *      (approximated as 07:00 UTC — valid for both CET and CEST offsets)
 *   2. Days: newDays must equal originalDays, or 7 if original was 6
 *   3. Discount: new period discount must be >= original (non-blocking if pricing fails)
 */

import { getOdinToken } from './odin-auth.js';

const ODIN_BASE  = 'https://odin.alpy.com';
const SHOPS_URL  = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Shops cache ───────────────────────────────────────────────────────────────
let _shopsCache = null;
async function getShops() {
  if (_shopsCache) return _shopsCache;
  const r = await fetch(SHOPS_URL);
  if (!r.ok) throw new Error(`Failed to load shops data: ${r.status}`);
  _shopsCache = await r.json();
  return _shopsCache;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDateStr(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  } catch { return null; }
}

function customerField(booking, subKey) {
  return (
    booking?.customer?.[subKey] ||
    booking?.[`customer${subKey.charAt(0).toUpperCase()}${subKey.slice(1)}`] ||
    null
  );
}

async function odinSearch(token, params) {
  const url = `${ODIN_BASE}/api/v2/bookings?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odin search failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
}

async function getBookingByUUID(token, bookingId) {
  const res = await fetch(`${ODIN_BASE}/api/v2/bookings/${bookingId}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Odin booking fetch failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  // Odin may wrap in { data: {...} }
  return data?.data ?? data;
}

/**
 * Resolve a booking from the request body.
 * Returns the raw Odin booking object or throws.
 */
async function resolveBooking(token, body) {
  const { bookingReference, customerName, customerEmail, customerLastName, bookingId } = body;

  if (bookingId) {
    return await getBookingByUUID(token, bookingId);
  }

  if (bookingReference && customerName) {
    const params = new URLSearchParams({ bookingReference: bookingReference.trim().toUpperCase(), limit: '1' });
    const bookings = await odinSearch(token, params);
    if (!bookings.length) throw new Error('BOOKING_NOT_FOUND');
    return bookings[0];
  }

  if (customerEmail && customerLastName) {
    const params = new URLSearchParams({
      customerEmail: customerEmail.trim().toLowerCase(),
      customerName: customerLastName.trim(),
      limit: '5',
    });
    let bookings = await odinSearch(token, params);
    if (!bookings.length) throw new Error('BOOKING_NOT_FOUND');
    if (bookings.length > 1) {
      const needle = customerLastName.trim().toLowerCase();
      const match = bookings.find(b => (customerField(b, 'name') || '').toLowerCase().includes(needle));
      if (match) bookings = [match];
    }
    return bookings[0];
  }

  throw new Error('MISSING_LOOKUP_PARAMS');
}

/**
 * Build the deadline (day before rentalFrom at 07:00 UTC ≈ 08:00 Paris).
 */
function buildDeadline(rentalFrom) {
  const d = new Date(rentalFrom);
  const deadline = new Date(d);
  deadline.setUTCDate(deadline.getUTCDate() - 1);
  deadline.setUTCHours(7, 0, 0, 0);
  return deadline;
}

/**
 * Extract ages from booking items. Falls back to personsCount × [35].
 */
function extractAges(booking) {
  const items = Array.isArray(booking.items) ? booking.items : [];
  const now = Date.now();
  const ages = [];

  for (const item of items) {
    if (item.birthDate) {
      const age = Math.floor((now - new Date(item.birthDate)) / 31557600000);
      ages.push(age > 0 && age < 120 ? age : 35);
    } else if (typeof item.age === 'number') {
      ages.push(item.age);
    }
  }

  if (ages.length === 0) {
    // Fall back: use personsCount from equipment items or all items
    const equipmentItems = items.filter(
      i => i?.type?.toLowerCase() === 'equipment' || i?.category?.toLowerCase() === 'equipment'
    );
    const count = equipmentItems.length > 0 ? equipmentItems.length : Math.max(items.length, 1);
    return Array(count).fill(35);
  }

  return ages;
}

/**
 * Fetch offers for a given town + period and extract best price/discount.
 * Returns { totalPrice, discount } or null on failure.
 */
async function fetchOfferInfo({ token, townSlug, startDate, rentalDays, ages, currency = 'EUR', countryCode = 'FR' }) {
  const startDateISO = new Date(startDate).toISOString();
  const offerParams = new URLSearchParams({ currency, startDate: startDateISO, rentalDays, countryCode });
  ages.forEach(a => offerParams.append('ages[]', a));

  const res = await fetch(
    `${ODIN_BASE}/api/v2/location/town/${encodeURIComponent(townSlug)}/offers?${offerParams}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  if (!res.ok) return null;

  const data = await res.json();
  const offerList = Array.isArray(data) ? data : data.data || data.offers || [];
  if (!offerList.length) return null;

  // Pick the offer matching the booking's shop, or the cheapest
  let best = null;
  let bestTotal = Infinity;
  for (const offer of offerList) {
    const total = offer.totalPrice ?? offer.price ?? offer.total ?? offer.amount;
    if (typeof total === 'number' && total < bestTotal) {
      bestTotal = total;
      best = offer;
    }
  }
  if (!best) return null;

  // Derive discount: prefer explicit field, then compute from originalPrice
  let discount = 0;
  if (typeof best.discountPercent === 'number') {
    discount = best.discountPercent / 100;
  } else if (typeof best.originalPrice === 'number' && best.originalPrice > 0) {
    discount = 1 - bestTotal / best.originalPrice;
  }
  // Clamp to [0, 1]
  discount = Math.max(0, Math.min(1, discount));

  return { totalPrice: bestTotal, discount };
}

/**
 * Map a booking's shop country to ISO country code.
 */
function countryCodeFromShopCountry(country) {
  const MAP = { france: 'FR', austria: 'AT', switzerland: 'CH', italy: 'IT', germany: 'DE', spain: 'ES', andorra: 'AD' };
  return MAP[(country || '').toLowerCase()] || 'FR';
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = req.body || {};
  const { newStartDate, newEndDate } = body;

  // Validate required date params
  if (!newStartDate || !newEndDate) {
    return res.status(400).json({ error: 'Missing required params: newStartDate and newEndDate (YYYY-MM-DD).' });
  }

  const newStart = toDateStr(newStartDate);
  const newEnd   = toDateStr(newEndDate);
  if (!newStart || !newEnd) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (new Date(newStart) >= new Date(newEnd)) {
    return res.status(400).json({ error: 'newStartDate must be before newEndDate.' });
  }

  // Validate lookup params
  const hasLookup = body.bookingId || (body.bookingReference && body.customerName) || (body.customerEmail && body.customerLastName);
  if (!hasLookup) {
    return res.status(400).json({
      error: 'Provide one of: bookingId | (bookingReference + customerName) | (customerEmail + customerLastName).',
    });
  }

  try {
    const token  = await getOdinToken();
    const shops  = await getShops();

    // ── 1. Fetch booking ──────────────────────────────────────────────────────
    let booking;
    try {
      booking = await resolveBooking(token, body);
    } catch (err) {
      if (err.message === 'BOOKING_NOT_FOUND') {
        return res.status(404).json({ found: false, error: 'No booking found for the provided details.' });
      }
      if (err.message === 'MISSING_LOOKUP_PARAMS') {
        return res.status(400).json({ error: 'Insufficient lookup parameters.' });
      }
      throw err;
    }

    const bookingId        = booking.id ?? null;
    const bookingReference = booking.bookingReference ?? null;
    const rentalFrom       = booking.rentalFrom ?? null;
    const rentalTo         = booking.rentalTo   ?? null;
    const originalStart    = toDateStr(rentalFrom);
    const originalEnd      = toDateStr(rentalTo);

    if (!originalStart || !originalEnd) {
      return res.status(422).json({ error: 'Booking has missing rental dates in Odin.' });
    }

    // ── 2. Deadline check ─────────────────────────────────────────────────────
    const deadline    = buildDeadline(rentalFrom);
    const now         = new Date();
    const deadlinePassed = now >= deadline;

    if (deadlinePassed) {
      return res.status(200).json({
        allowed:             false,
        reason:              'DEADLINE_PASSED',
        message:             `Date changes must be requested before ${deadline.toISOString()} (day before rental start at 08:00 Paris time). The deadline has passed.`,
        bookingId,
        bookingReference,
        shopName:            booking.shop?.name ?? null,
        originalStartDate:   originalStart,
        originalEndDate:     originalEnd,
        originalDays:        Math.ceil((new Date(originalEnd) - new Date(originalStart)) / 86400000),
        newStartDate:        newStart,
        newEndDate:          newEnd,
        newDays:             Math.ceil((new Date(newEnd) - new Date(newStart)) / 86400000),
        originalPrice:       booking.totalPrice ?? null,
        originalDiscount:    null,
        newPrice:            null,
        newDiscount:         null,
        discountCheckSkipped: true,
        deadline:            deadline.toISOString(),
      });
    }

    // ── 3. Days check ─────────────────────────────────────────────────────────
    const originalDays = Math.ceil((new Date(originalEnd) - new Date(originalStart)) / 86400000);
    const newDays      = Math.ceil((new Date(newEnd)      - new Date(newStart))      / 86400000);
    const daysOk       = newDays === originalDays || (originalDays === 6 && newDays === 7);

    if (!daysOk) {
      return res.status(200).json({
        allowed:             false,
        reason:              'DAYS_MISMATCH',
        message:             `New rental period is ${newDays} day(s), but booking has ${originalDays} day(s). ` +
                             `Date changes must keep the same number of days${originalDays === 6 ? ' (or extend from 6 to 7 days)' : ''}.`,
        bookingId,
        bookingReference,
        shopName:            booking.shop?.name ?? null,
        originalStartDate:   originalStart,
        originalEndDate:     originalEnd,
        originalDays,
        newStartDate:        newStart,
        newEndDate:          newEnd,
        newDays,
        originalPrice:       booking.totalPrice ?? null,
        originalDiscount:    null,
        newPrice:            null,
        newDiscount:         null,
        discountCheckSkipped: true,
        deadline:            deadline.toISOString(),
      });
    }

    // ── 4. Discount check (non-blocking) ──────────────────────────────────────
    let originalPrice    = booking.totalPrice ?? null;
    let originalDiscount = null;
    let newPrice         = null;
    let newDiscount      = null;
    let discountCheckSkipped = false;
    let discountLower    = false;

    try {
      // Find the shop in shops_data to build the townSlug
      const shopId   = booking.shop?.id;
      const shopSlug = booking.shop?.slug;
      const shopRegion  = booking.shop?.region;
      const shopCountry = booking.shop?.country;

      let shop = null;
      if (shopId) {
        shop = shops.find(s => s.id === parseInt(shopId));
      }
      if (!shop && shopSlug && shopRegion && shopCountry) {
        shop = shops.find(s => s.slug === shopSlug && s.region === shopRegion && s.country === shopCountry);
      }

      if (!shop) throw new Error('Shop not found in shops_data');

      const townSlug   = `${shop.country}/${shop.region}/${shop.slug}`;
      const countryCode = countryCodeFromShopCountry(shop.country);
      const ages        = extractAges(booking);

      const [origOffer, newOffer] = await Promise.all([
        fetchOfferInfo({ token, townSlug, startDate: originalStart, rentalDays: originalDays, ages, countryCode }),
        fetchOfferInfo({ token, townSlug, startDate: newStart,      rentalDays: newDays,      ages, countryCode }),
      ]);

      if (!origOffer || !newOffer) throw new Error('Pricing unavailable for one or both periods');

      originalPrice    = origOffer.totalPrice;
      originalDiscount = origOffer.discount;
      newPrice         = newOffer.totalPrice;
      newDiscount      = newOffer.discount;

      // Discount check: new must be >= original
      discountLower = newDiscount < originalDiscount - 0.001; // small epsilon for float comparison
    } catch {
      discountCheckSkipped = true;
    }

    const allowed = !discountLower;
    const reason  = discountLower ? 'DISCOUNT_LOWER' : null;

    let message;
    if (discountCheckSkipped) {
      message = 'Date change is allowed. Pricing check was skipped (unavailable for one or both periods).';
    } else if (discountLower) {
      const origPct = Math.round((originalDiscount ?? 0) * 100);
      const newPct  = Math.round((newDiscount ?? 0) * 100);
      message = `Date change is not allowed: the new period has a lower discount (${newPct}%) than the original (${origPct}%).`;
    } else {
      const newPct  = Math.round((newDiscount ?? 0) * 100);
      message = `Date change is allowed.${newPct > 0 ? ` New period discount: ${newPct}%.` : ''}`;
    }

    return res.status(200).json({
      allowed,
      reason,
      message,
      bookingId,
      bookingReference,
      shopName:             booking.shop?.name ?? null,
      originalStartDate:    originalStart,
      originalEndDate:      originalEnd,
      originalDays,
      newStartDate:         newStart,
      newEndDate:           newEnd,
      newDays,
      originalPrice:        originalPrice !== null ? Number(originalPrice) : null,
      originalDiscount:     originalDiscount !== null ? Math.round(originalDiscount * 10000) / 10000 : null,
      newPrice:             newPrice !== null ? Number(newPrice) : null,
      newDiscount:          newDiscount !== null ? Math.round(newDiscount * 10000) / 10000 : null,
      discountCheckSkipped,
      deadline:             deadline.toISOString(),
    });

  } catch (err) {
    console.error('[check-date-change] Error:', err);
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
}
