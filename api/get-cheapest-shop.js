/**
 * GET /api/get-cheapest-shop?town=morzine&startDate=2026-03-21&days=7&ages=35,12&currency=EUR&countryCode=FR
 *
 * Returns the cheapest shop + price for a given resort/dates.
 * Used for the quote flow: customer picks a resort → bot gets cheapest price.
 * Handles Odin OAuth token refresh automatically.
 */

import { getOdinToken } from './odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const {
    town,        // town slug e.g. "morzine"
    startDate,   // ISO date e.g. "2026-03-21"
    days,        // rental days e.g. "7"
    ages,        // comma-separated ages e.g. "35,12,8"
    currency = 'EUR',
    countryCode = 'FR',
    promoCode,
  } = req.query;

  if (!town || !startDate || !days || !ages) {
    return res.status(400).json({ error: 'Required: town, startDate, days, ages' });
  }

  try {
    const token = await getOdinToken();

    // Step 1: Get all shops in the town
    const shopsRes = await fetch(`${ODIN_BASE}/api/v2/location/town/${encodeURIComponent(town)}/shops`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    if (!shopsRes.ok) {
      const body = await shopsRes.text();
      return res.status(502).json({ error: `Shop list failed: ${shopsRes.status}`, details: body.slice(0, 300) });
    }

    const shops = await shopsRes.json();
    const shopList = Array.isArray(shops) ? shops : shops.data || shops.shops || [];

    if (!shopList.length) {
      return res.status(404).json({ error: `No shops found for town: ${town}` });
    }

    // Step 2: Get offers for this town
    const agesArr = ages.split(',').map(a => parseInt(a.trim())).filter(Boolean);
    const startDateISO = new Date(startDate).toISOString();

    const offerParams = new URLSearchParams({
      currency,
      startDate: startDateISO,
      rentalDays: days,
      countryCode,
    });
    agesArr.forEach(a => offerParams.append('ages[]', a));
    if (promoCode) offerParams.set('promoCode', promoCode);

    const offersRes = await fetch(
      `${ODIN_BASE}/api/v2/location/town/${encodeURIComponent(town)}/offers?${offerParams}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );

    if (!offersRes.ok) {
      return res.status(502).json({
        error: `Offers failed: ${offersRes.status}`,
        details: (await offersRes.text()).slice(0, 300),
      });
    }

    const offers = await offersRes.json();
    const offerList = Array.isArray(offers) ? offers : offers.data || offers.offers || [];

    // Step 3: Find cheapest offer
    let cheapest = null;
    let cheapestPrice = Infinity;

    for (const offer of offerList) {
      const price = offer.totalPrice ?? offer.price ?? offer.total ?? offer.amount;
      if (typeof price === 'number' && price < cheapestPrice) {
        cheapestPrice = price;
        cheapest = offer;
      }
    }

    if (!cheapest) {
      return res.status(404).json({ error: 'No priced offers found', offersCount: offerList.length });
    }

    return res.status(200).json({
      town,
      cheapestShop: cheapest.shop || cheapest.shopName || cheapest,
      price: cheapestPrice,
      currency,
      startDate,
      days: parseInt(days),
      raw: cheapest,
    });
  } catch (err) {
    console.error('[get-cheapest-shop]', err);
    return res.status(500).json({ error: err.message });
  }
}
