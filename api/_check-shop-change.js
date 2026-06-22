/**
 * POST /api/check-shop-change
 *
 * Checks whether moving a booking to a different shop is allowed.
 *
 * Body params (booking lookup — one combo required):
 *   Combo A: { bookingReference, customerName }
 *   Combo B: { customerEmail, customerLastName }
 *   Combo C: { bookingId }
 *
 * Shop selection (one required):
 *   newShopId   integer  — Odin legacy shop ID
 *   newResort   string   — resort/town name (same norm() matching as generate-quote.js)
 *
 * Business rules:
 *   1. Deadline: same as date change (day before rental start at 08:00 Paris / 07:00 UTC)
 *   2. Price/discount: new shop must be cheaper OR have same/better discount.
 *      Rule (lenient): allowed if newPrice <= originalPrice OR newDiscount >= originalDiscount.
 *      If new shop is cheaper, that is sufficient even if discount % is technically different.
 *
 * Returns pricing comparison and a cartUrl for the new shop if allowed.
 */

import { getOdinToken } from './_odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';
const SHOPS_URL = 'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Product definition IDs (same as generate-quote.js) ───────────────────────
const PRODUCTS = {
  adult:  { ski: { beginner: 2,   intermediate: 3,  expert: 4  }, snowboard: { beginner: 28, intermediate: 30, expert: 31 } },
  teen:   { ski: { beginner: 129, intermediate: 96, expert: 92 }, snowboard: { beginner: 97, intermediate: 97, expert: 97 } },
  junior: { ski: { beginner: 15,  intermediate: 15, expert: 16 }, snowboard: { beginner: 42, intermediate: 42, expert: 43 } },
  child:  { ski: { beginner: 80,  intermediate: 80, expert: 81 }, snowboard: { beginner: 38, intermediate: 38, expert: 43 } },
};

function getCategory(age) {
  if (age <= 6)  return 'child';
  if (age <= 12) return 'junior';
  if (age <= 17) return 'teen';
  return 'adult';
}

function getDefinitionId(age, skill, equipment) {
  const cat  = getCategory(parseInt(age) || 35);
  const equip = equipment === 'snowboard' ? 'snowboard' : 'ski';
  const sk   = ['beginner', 'intermediate', 'expert'].includes(skill) ? skill : 'intermediate';
  return PRODUCTS[cat][equip][sk];
}

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

/** Normalize: lowercase + strip diacritics + strip apostrophes/dots/hyphens */
function norm(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[''`']/g, '')
    .replace(/[.\-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find first shop matching a resort/town name.
 * Same logic as generate-quote.js.
 */
function findShopByResort(shops, resort) {
  if (!resort) return null;
  const q   = norm(resort);
  const qNS = q.replace(/\s/g, '');

  // 1. Exact town
  for (const s of shops) {
    const t = norm(s.town);
    if (t === q || t.replace(/\s/g, '') === qNS) return s;
  }
  // 2. Partial town
  for (const s of shops) {
    const tl = norm(s.town);
    if (tl.includes(q) || tl.replace(/\s/g, '').includes(qNS)) return s;
  }
  // 3. Partial shop name
  for (const s of shops) {
    const nl = norm(s.name);
    if (nl.includes(q) || nl.replace(/\s/g, '').includes(qNS)) return s;
  }
  return null;
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
  return data?.data ?? data;
}

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

function buildDeadline(rentalFrom) {
  const d = new Date(rentalFrom);
  const deadline = new Date(d);
  deadline.setUTCDate(deadline.getUTCDate() - 1);
  deadline.setUTCHours(7, 0, 0, 0);
  return deadline;
}

function countryCodeFromShopCountry(country) {
  const MAP = { france: 'FR', austria: 'AT', switzerland: 'CH', italy: 'IT', germany: 'DE', spain: 'ES', andorra: 'AD' };
  return MAP[(country || '').toLowerCase()] || 'FR';
}

/**
 * Extract ages from booking items (same logic as check-date-change.js).
 */
function extractAges(booking) {
  const items = Array.isArray(booking.items) ? booking.items : [];
  const now   = Date.now();
  const ages  = [];

  for (const item of items) {
    if (item.birthDate) {
      const age = Math.floor((now - new Date(item.birthDate)) / 31557600000);
      ages.push(age > 0 && age < 120 ? age : 35);
    } else if (typeof item.age === 'number') {
      ages.push(item.age);
    }
  }

  if (ages.length === 0) {
    const equipmentItems = items.filter(
      i => i?.type?.toLowerCase() === 'equipment' || i?.category?.toLowerCase() === 'equipment'
    );
    const count = equipmentItems.length > 0 ? equipmentItems.length : Math.max(items.length, 1);
    return Array(count).fill(35);
  }

  return ages;
}

/**
 * Fetch best offer for a shop's town + period.
 * Returns { totalPrice, discount, originalPrice } or null.
 */
async function fetchOfferInfo({ token, townSlug, startDate, rentalDays, ages, currency = 'EUR', countryCode = 'FR' }) {
  try {
    const startDateISO = new Date(startDate).toISOString();
    const offerParams  = new URLSearchParams({ currency, startDate: startDateISO, rentalDays, countryCode });
    ages.forEach(a => offerParams.append('ages[]', a));

    const res = await fetch(
      `${ODIN_BASE}/api/v2/location/town/${encodeURIComponent(townSlug)}/offers?${offerParams}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!res.ok) return null;

    const data = await res.json();
    const offerList = Array.isArray(data) ? data : data.data || data.offers || [];
    if (!offerList.length) return null;

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

    const rawOriginal = best.originalPrice ?? null;
    let discount = 0;
    if (typeof best.discountPercent === 'number') {
      discount = best.discountPercent / 100;
    } else if (typeof rawOriginal === 'number' && rawOriginal > 0) {
      discount = 1 - bestTotal / rawOriginal;
    }
    discount = Math.max(0, Math.min(1, discount));

    return { totalPrice: bestTotal, discount, originalPrice: rawOriginal };
  } catch {
    return null;
  }
}

/**
 * Build a cart URL for a shop (same logic as generate-quote.js).
 */
function buildCartUrl({ shop, startDate, endDate, ages, lang = 'en', promoCode = '' }) {
  // Build persons array from ages — default to intermediate ski for all
  const cartPersons = ages.map(age => ({
    age,
    skill: 'advanced',
    products: [{ definitionId: getDefinitionId(age, 'intermediate', 'ski'), addons: [1] }],
  }));

  const cart    = { promotionCode: promoCode, persons: cartPersons, insurances: [] };
  const shopUrl = `https://www.alpy.com/${lang}/ski-rental/${shop.country}/${shop.region}/${shop.slug}/${shop.id}`;
  return `${shopUrl}/products?cart=${encodeURIComponent(JSON.stringify(cart))}&startDate=${startDate}&endDate=${endDate}`;
}

// ── Main handler ──────────────────────────────────────────────────────────────
// ── Claude JSON blob normalizer ───────────────────────────────────────────────
function expandBlob(raw) {
  const b = { ...raw };
  const blob = Object.values(b).find(v => typeof v === 'string' && v.trim().startsWith('{'));
  if (blob) { try { Object.assign(b, JSON.parse(blob)); } catch {} }
  const LC = { bookingreference:'bookingReference', bookingid:'bookingId', customername:'customerName',
    customeremail:'customerEmail', customerlastname:'customerLastName',
    newresort:'newResort', newshopid:'newShopId' };
  for (const [lc, cc] of Object.entries(LC)) if (b[lc] !== undefined && b[cc] === undefined) b[cc] = b[lc];
  return b;
}

export async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = expandBlob(req.body || {});
  const { newShopId, newResort } = body;

  // Validate lookup params
  const hasLookup = body.bookingId || (body.bookingReference && body.customerName) || (body.customerEmail && body.customerLastName);
  if (!hasLookup) {
    return res.status(400).json({
      error: 'Provide one of: bookingId | (bookingReference + customerName) | (customerEmail + customerLastName).',
    });
  }
  if (!newShopId && !newResort) {
    return res.status(400).json({ error: 'Provide newShopId (integer) or newResort (resort/town name).' });
  }

  try {
    const token = await getOdinToken();
    const shops = await getShops();

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

    const rentalFrom    = booking.rentalFrom ?? null;
    const rentalTo      = booking.rentalTo   ?? null;
    const originalStart = toDateStr(rentalFrom);
    const originalEnd   = toDateStr(rentalTo);

    if (!originalStart || !originalEnd) {
      return res.status(422).json({ error: 'Booking has missing rental dates in Odin.' });
    }

    // ── 2. Deadline check ─────────────────────────────────────────────────────
    const deadline = buildDeadline(rentalFrom);
    if (new Date() >= deadline) {
      return res.status(200).json({
        allowed:           false,
        reason:            'DEADLINE_PASSED',
        message:           `Shop changes must be requested before ${deadline.toISOString()} (day before rental start at 08:00 Paris time). The deadline has passed.`,
        originalShopName:  booking.shop?.name ?? null,
        newShopName:       null,
        originalPrice:     booking.totalPrice ?? null,
        newPrice:          null,
        originalDiscount:  null,
        newDiscount:       null,
        currency:          booking.currency ?? 'EUR',
        period:            `${originalStart} → ${originalEnd}`,
        cartUrlNewShop:    null,
        pricingSavings:    null,
      });
    }

    // ── 3. Find new shop ──────────────────────────────────────────────────────
    let newShop = null;
    if (newShopId) {
      newShop = shops.find(s => s.id === parseInt(newShopId)) || null;
    } else if (newResort) {
      newShop = findShopByResort(shops, String(newResort));
    }

    if (!newShop) {
      return res.status(200).json({
        allowed:           false,
        reason:            'SHOP_NOT_FOUND',
        message:           newShopId
          ? `No shop found with ID ${newShopId}.`
          : `No shop found for resort: "${newResort}". Check spelling or use alpy.com to find a valid resort name.`,
        originalShopName:  booking.shop?.name ?? null,
        newShopName:       null,
        originalPrice:     booking.totalPrice ?? null,
        newPrice:          null,
        originalDiscount:  null,
        newDiscount:       null,
        currency:          booking.currency ?? 'EUR',
        period:            `${originalStart} → ${originalEnd}`,
        cartUrlNewShop:    null,
        pricingSavings:    null,
      });
    }

    // ── 4. Find original shop in shops_data ───────────────────────────────────
    const origShopOdinId = booking.shop?.id;
    const origShopSlug   = booking.shop?.slug;
    let originalShop     = null;
    if (origShopOdinId) {
      originalShop = shops.find(s => s.id === parseInt(origShopOdinId)) || null;
    }
    if (!originalShop && origShopSlug) {
      originalShop = shops.find(s => s.slug === origShopSlug) || null;
    }

    // ── 5. Pricing comparison ─────────────────────────────────────────────────
    const rentalDays  = Math.ceil((new Date(originalEnd) - new Date(originalStart)) / 86400000);
    const ages        = extractAges(booking);
    const currency    = booking.currency ?? 'EUR';

    const origTownSlug = originalShop
      ? `${originalShop.country}/${originalShop.region}/${originalShop.slug}`
      : null;
    const newTownSlug  = `${newShop.country}/${newShop.region}/${newShop.slug}`;

    const origCountryCode = countryCodeFromShopCountry(originalShop?.country ?? booking.shop?.country);
    const newCountryCode  = countryCodeFromShopCountry(newShop.country);

    const [origOffer, newOffer] = await Promise.all([
      origTownSlug
        ? fetchOfferInfo({ token, townSlug: origTownSlug, startDate: originalStart, rentalDays, ages, currency, countryCode: origCountryCode })
        : Promise.resolve(null),
      fetchOfferInfo({ token, townSlug: newTownSlug, startDate: originalStart, rentalDays, ages, currency, countryCode: newCountryCode }),
    ]);

    // Use booking's totalPrice as fallback for original
    const originalPrice    = origOffer?.totalPrice ?? (typeof booking.totalPrice === 'number' ? booking.totalPrice : null);
    const originalDiscount = origOffer?.discount   ?? null;
    const newPrice         = newOffer?.totalPrice   ?? null;
    const newDiscount      = newOffer?.discount     ?? null;

    // ── 6. Allowance decision (lenient) ───────────────────────────────────────
    let allowed   = false;
    let reason    = null;
    let message   = '';

    if (newPrice === null || originalPrice === null) {
      // Pricing unavailable — allow with caveat
      allowed = true;
      message = 'Shop change appears allowed. Live pricing was unavailable for comparison — please verify prices manually.';
    } else {
      const cheaper       = newPrice <= originalPrice;
      const betterDiscount = newDiscount !== null && originalDiscount !== null
        ? newDiscount >= originalDiscount - 0.001
        : true; // unknown discount — don't penalise

      // Lenient: allowed if cheaper OR better/equal discount
      if (cheaper || betterDiscount) {
        allowed = true;
        const savingsPct = originalPrice > 0
          ? Math.round((1 - newPrice / originalPrice) * 100)
          : 0;
        if (cheaper && savingsPct > 0) {
          message = `Shop change is allowed. New shop is ${savingsPct}% cheaper (${currency} ${(originalPrice - newPrice).toFixed(2)} savings).`;
        } else if (!cheaper && betterDiscount) {
          const newPct  = Math.round((newDiscount ?? 0) * 100);
          const origPct = Math.round((originalDiscount ?? 0) * 100);
          message = `Shop change is allowed. New shop has a better or equal discount (${newPct}% vs ${origPct}%).`;
        } else {
          message = 'Shop change is allowed. New shop pricing is comparable to the original.';
        }
      } else {
        allowed = false;
        reason  = 'PRICE_HIGHER';
        const diffAmt = (newPrice - originalPrice).toFixed(2);
        const newPct  = Math.round((newDiscount ?? 0) * 100);
        const origPct = Math.round((originalDiscount ?? 0) * 100);
        message = `Shop change is not allowed: new shop is ${currency} ${diffAmt} more expensive and has a lower discount (${newPct}% vs ${origPct}%).`;
      }
    }

    // ── 7. Build cart URL for new shop ────────────────────────────────────────
    const cartUrlNewShop = allowed
      ? buildCartUrl({ shop: newShop, startDate: originalStart, endDate: originalEnd, ages, lang: 'en' })
      : null;

    const pricingSavings = (allowed && newPrice !== null && originalPrice !== null)
      ? Math.round((originalPrice - newPrice) * 100) / 100
      : null;

    return res.status(200).json({
      allowed,
      reason,
      message,
      originalShopName:  booking.shop?.name ?? null,
      newShopName:       newShop.name,
      originalPrice:     originalPrice !== null ? Math.round(originalPrice * 100) / 100 : null,
      newPrice:          newPrice      !== null ? Math.round(newPrice * 100) / 100      : null,
      originalDiscount:  originalDiscount !== null ? Math.round(originalDiscount * 10000) / 10000 : null,
      newDiscount:       newDiscount      !== null ? Math.round(newDiscount * 10000) / 10000      : null,
      currency,
      period:            `${originalStart} → ${originalEnd}`,
      cartUrlNewShop,
      pricingSavings,
    });

  } catch (err) {
    console.error('[check-shop-change] Error:', err);
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
}
