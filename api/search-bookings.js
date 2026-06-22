/**
 * GET /api/search-bookings?email=X&name=X&ref=X&status=X&limit=20
 *
 * Searches Odin bookings using OAuth. Callable from Zendesk Custom Actions.
 * Handles token refresh automatically.
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

  const { email, name, ref, status, limit = 20, offset = 0, orderBy } = req.query;

  if (!email && !name && !ref) {
    return res.status(400).json({ error: 'Provide at least one of: email, name, ref' });
  }

  try {
    const token = await getOdinToken();

    // Build query params
    const params = new URLSearchParams();
    if (email) params.set('customerEmail', email);
    if (name) params.set('customerName', name);
    if (ref) params.set('bookingReference', ref);
    if (status) params.set('status', status);
    if (orderBy) params.set('orderBy', orderBy);
    params.set('limit', String(limit));
    params.set('offset', String(offset));

    // Try the most likely endpoint patterns
    const endpoints = [
      `/api/v2/booking/search?${params}`,
      `/api/v2/bookings?${params}`,
    ];

    let lastError;
    for (const endpoint of endpoints) {
      const r = await fetch(`${ODIN_BASE}${endpoint}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (r.ok) {
        const data = await r.json();
        return res.status(200).json(Array.isArray(data) ? data : data.data || data.bookings || data);
      }

      const body = await r.text().catch(() => '');
      // 404 = wrong path, try next; anything else = real error
      if (r.status !== 404 && r.status !== 405) {
        lastError = { status: r.status, body };
        break;
      }
      lastError = { status: r.status, body, endpoint };
    }

    // None worked - return the last error for debugging
    return res.status(502).json({
      error: 'Could not find booking search endpoint',
      details: lastError,
    });
  } catch (err) {
    console.error('[search-bookings]', err);
    return res.status(500).json({ error: err.message });
  }
}
