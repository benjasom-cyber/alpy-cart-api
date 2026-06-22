/**
 * POST /api/update-personal-info
 *
 * Updates a skier's fitting information (birthdate, height, weight, shoe size,
 * ski level) for one or all equipment items within a booking.
 *
 * Body params:
 *   Booking identification (one of):
 *     bookingId         - UUID of the booking
 *     bookingReference  + customerName   - ref code (e.g. "BZGBDJ") + customer name
 *     customerEmail     + customerLastName
 *
 *   Skier targeting (optional — omit both to update ALL skiers):
 *     skierName   (string)  - case-insensitive match against item name
 *     skierIndex  (integer) - 0-based index into equipment items array
 *
 *   Fields to update (all optional — only provided fields are patched):
 *     birthDate  (YYYY-MM-DD)
 *     height     (cm integer)
 *     weight     (kg integer)
 *     shoeSize   (EU integer)
 *     skiLevel   (beginner | intermediate | expert)
 *
 * Returns:
 *   { success, bookingReference, updatedSkiers, updatedFields, message }
 */

import { getOdinToken } from './odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Webhook-Secret',
};

/** Map customer-facing skill labels to Odin's enum values. */
function mapSkiLevel(level) {
  if (!level) return undefined;
  const l = String(level).toLowerCase();
  if (l === 'beginner')     return 'BEGINNER';
  if (l === 'intermediate') return 'ADVANCED';
  if (l === 'expert')       return 'EXPERT';
  return l.toUpperCase(); // pass through already-mapped values
}

/**
 * Resolve a booking to its Odin UUID.
 * Tries bookingId directly; falls back to search by reference or email.
 * Returns { bookingId, bookingReference, booking } or throws.
 */
async function resolveBooking(params, token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // -- Direct UUID lookup
  if (params.bookingId) {
    const res = await fetch(`${ODIN_BASE}/api/v2/bookings/${params.bookingId}`, { headers });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Booking not found (${res.status}): ${body}`);
    }
    const booking = await res.json();
    return {
      bookingId: params.bookingId,
      bookingReference: booking.reference || booking.bookingReference || params.bookingId,
      booking,
    };
  }

  // -- Search by reference or email
  const searchParams = new URLSearchParams();
  if (params.bookingReference) searchParams.set('bookingReference', params.bookingReference);
  if (params.customerName)     searchParams.set('customerName',     params.customerName);
  if (params.customerEmail)    searchParams.set('customerEmail',    params.customerEmail);
  if (params.customerLastName) searchParams.set('customerName',     params.customerLastName);

  const endpoints = [
    `/api/v2/booking/search?${searchParams}`,
    `/api/v2/bookings?${searchParams}`,
  ];

  for (const endpoint of endpoints) {
    const res = await fetch(`${ODIN_BASE}${endpoint}`, { headers });
    if (!res.ok) continue;
    const data = await res.json();
    const list = Array.isArray(data) ? data : data.data || data.bookings || [];
    if (list.length === 0) throw new Error('No booking found for the provided search criteria.');
    const booking = list[0];
    const bookingId = booking.id || booking.bookingId;
    if (!bookingId) throw new Error('Could not extract booking ID from search result.');
    return {
      bookingId,
      bookingReference: booking.reference || booking.bookingReference || bookingId,
      booking,
    };
  }

  throw new Error('Could not reach booking search endpoint.');
}

/**
 * Extract equipment items from a booking.
 * Equipment items are those that carry personalInfo or have type === 'equipment'.
 */
function extractEquipmentItems(booking) {
  const items = booking.items || booking.bookingItems || [];
  return items.filter(item =>
    item.personalInfo !== undefined ||
    (item.type && String(item.type).toLowerCase() === 'equipment')
  );
}

/**
 * Identify which items to update given skierName / skierIndex.
 * Returns a subset (or all) of the equipment items array.
 */
function selectItems(equipmentItems, skierName, skierIndex) {
  if (skierName !== undefined && skierName !== null) {
    const q = String(skierName).toLowerCase();
    const matched = equipmentItems.filter(item => {
      const nameA = String(item.name || '').toLowerCase();
      const nameB = String((item.personalInfo && item.personalInfo.name) || '').toLowerCase();
      return nameA.includes(q) || nameB.includes(q);
    });
    if (matched.length === 0) {
      throw new Error(`No skier found matching name "${skierName}".`);
    }
    return matched;
  }

  if (skierIndex !== undefined && skierIndex !== null) {
    const idx = parseInt(skierIndex);
    if (isNaN(idx) || idx < 0 || idx >= equipmentItems.length) {
      throw new Error(`skierIndex ${skierIndex} out of range (0–${equipmentItems.length - 1}).`);
    }
    return [equipmentItems[idx]];
  }

  // Neither given — update all
  return equipmentItems;
}

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = req.body || {};
  const {
    bookingId,
    bookingReference,
    customerName,
    customerEmail,
    customerLastName,
    skierName,
    skierIndex,
    birthDate,
    height,
    weight,
    shoeSize,
    skiLevel,
  } = body;

  // -- Validate that at least one booking identifier was provided
  if (!bookingId && !bookingReference && !customerEmail) {
    return res.status(400).json({
      error: 'Provide bookingId, or bookingReference+customerName, or customerEmail+customerLastName.',
    });
  }

  // -- Validate that at least one field to update was provided
  const providedFields = [];
  if (birthDate  !== undefined && birthDate  !== null) providedFields.push('birthDate');
  if (height     !== undefined && height     !== null) providedFields.push('height');
  if (weight     !== undefined && weight     !== null) providedFields.push('weight');
  if (shoeSize   !== undefined && shoeSize   !== null) providedFields.push('shoeSize');
  if (skiLevel   !== undefined && skiLevel   !== null) providedFields.push('skiLevel');

  if (providedFields.length === 0) {
    return res.status(400).json({
      error: 'Provide at least one field to update: birthDate, height, weight, shoeSize, skiLevel.',
    });
  }

  try {
    const token = await getOdinToken();
    const { bookingId: resolvedId, bookingReference: ref, booking } = await resolveBooking(
      { bookingId, bookingReference, customerName, customerEmail, customerLastName },
      token
    );

    const equipmentItems = extractEquipmentItems(booking);
    if (equipmentItems.length === 0) {
      return res.status(404).json({
        error: 'No equipment items found in this booking. Cannot update personal info.',
        bookingReference: ref,
      });
    }

    const targetItems = selectItems(equipmentItems, skierName, skierIndex);

    // -- Build the PATCH payload (only include provided fields)
    const patchBase = { selectedUnitType: 'METRIC' };
    if (birthDate !== undefined && birthDate !== null) {
      // Ensure ISO 8601 datetime format
      patchBase.birthDate = birthDate.length === 10
        ? `${birthDate}T00:00:00.000Z`
        : birthDate;
    }
    if (height   !== undefined && height   !== null) patchBase.height   = parseInt(height);
    if (weight   !== undefined && weight   !== null) patchBase.weight   = parseInt(weight);
    if (shoeSize !== undefined && shoeSize !== null) patchBase.shoeSize = parseInt(shoeSize);
    if (skiLevel !== undefined && skiLevel !== null) patchBase.skiLevel = mapSkiLevel(skiLevel);

    const updatedSkiers = [];
    const errors = [];
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    for (const item of targetItems) {
      const itemId = item.id || item.itemId;
      const itemName = (item.personalInfo && item.personalInfo.name)
        || item.name
        || `Item ${itemId}`;

      const payload = { ...patchBase };
      // Preserve existing name if we have it and none was supplied
      if (payload.name === undefined) {
        payload.name = itemName;
      }

      const patchRes = await fetch(
        `${ODIN_BASE}/api/v2/bookings/${resolvedId}/items/${itemId}/personal-info`,
        { method: 'PATCH', headers, body: JSON.stringify(payload) }
      );

      if (patchRes.ok) {
        updatedSkiers.push(itemName);
      } else {
        const errBody = await patchRes.text().catch(() => '');
        console.error(`[update-personal-info] PATCH failed for item ${itemId} (${patchRes.status}): ${errBody}`);
        errors.push({ skier: itemName, status: patchRes.status, detail: errBody });
      }
    }

    if (updatedSkiers.length === 0 && errors.length > 0) {
      return res.status(502).json({
        success: false,
        bookingReference: ref,
        errors,
        message: 'All PATCH requests failed. See errors for details.',
      });
    }

    return res.status(200).json({
      success: true,
      bookingReference: ref,
      updatedSkiers,
      updatedFields: providedFields,
      message: `Personal information updated successfully${errors.length ? ` (${errors.length} item(s) failed)` : ''}.`,
      ...(errors.length > 0 && { partialErrors: errors }),
    });
  } catch (err) {
    console.error('[update-personal-info]', err);
    return res.status(500).json({ error: err.message });
  }
}
