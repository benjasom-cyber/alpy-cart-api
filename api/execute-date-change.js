/**
 * POST /api/execute-date-change
 *
 * Applies a rental date change to a booking in Odin.
 *
 * Body params:
 *   bookingId     UUID (required)
 *   newStartDate  YYYY-MM-DD (required)
 *   newEndDate    YYYY-MM-DD (required)
 *   skipValidation boolean (optional) — skip deadline + days re-check if already validated
 *
 * Logic:
 *   1. Unless skipValidation: true, re-check deadline and days validity (no discount check).
 *   2. Convert dates to ISO strings.
 *   3. Try PUT /api/v2/bookings/{bookingId}/rental-period first.
 *      On 4xx/5xx, try PATCH /api/v2/bookings/{bookingId} as fallback.
 *   4. Return success payload.
 */

import { getOdinToken } from './odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function toDateStr(value) {
  if (!value) return null;
  try {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  } catch { return null; }
}

/**
 * Fetch a booking by UUID.
 */
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
 * Quick validation: deadline + days check only (no discount re-check).
 * Returns { valid: true } or { valid: false, reason, message }.
 */
function quickValidate(booking, newStart, newEnd) {
  const rentalFrom  = booking.rentalFrom ?? null;
  const rentalTo    = booking.rentalTo   ?? null;
  const originalStart = toDateStr(rentalFrom);
  const originalEnd   = toDateStr(rentalTo);

  if (!originalStart || !originalEnd) {
    return { valid: false, reason: 'INVALID_BOOKING', message: 'Booking has missing rental dates in Odin.' };
  }

  // Deadline
  const deadline = buildDeadline(rentalFrom);
  if (new Date() >= deadline) {
    return {
      valid: false,
      reason: 'DEADLINE_PASSED',
      message: `The date-change deadline has passed (${deadline.toISOString()}).`,
    };
  }

  // Days
  const originalDays = Math.ceil((new Date(originalEnd) - new Date(originalStart)) / 86400000);
  const newDays      = Math.ceil((new Date(newEnd)      - new Date(newStart))      / 86400000);
  const daysOk       = newDays === originalDays || (originalDays === 6 && newDays === 7);

  if (!daysOk) {
    return {
      valid: false,
      reason: 'DAYS_MISMATCH',
      message: `New rental period is ${newDays} day(s), but booking requires ${originalDays} day(s).`,
    };
  }

  return { valid: true };
}

/**
 * Attempt to update rental period via PUT; fall back to PATCH on failure.
 * Returns { ok: boolean, status: number, data: object, method: string }.
 */
async function callOdinUpdate(token, bookingId, rentalFrom, rentalTo) {
  // Odin expects fromDate / toDate (confirmed from MCP schema)
  const payload = JSON.stringify({ fromDate: rentalFrom, toDate: rentalTo });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  // Try PUT first
  const putRes = await fetch(`${ODIN_BASE}/api/v2/bookings/${bookingId}/rental-period`, {
    method: 'PUT',
    headers,
    body: payload,
  });

  if (putRes.ok) {
    let data = null;
    try { data = await putRes.json(); } catch { /* no body */ }
    return { ok: true, status: putRes.status, data, method: 'PUT' };
  }

  // Log PUT failure and try PATCH fallback
  console.warn(`[execute-date-change] PUT /rental-period returned ${putRes.status}, trying PATCH fallback`);

  const patchRes = await fetch(`${ODIN_BASE}/api/v2/bookings/${bookingId}`, {
    method: 'PATCH',
    headers,
    body: payload, // already { fromDate, toDate }
  });

  let patchData = null;
  try { patchData = await patchRes.json(); } catch { /* no body */ }

  if (patchRes.ok) {
    return { ok: true, status: patchRes.status, data: patchData, method: 'PATCH' };
  }

  // Both failed — return failure with details
  const putBody = await putRes.text().catch(() => '');
  return {
    ok: false,
    status: patchRes.status,
    data: patchData,
    method: 'PATCH',
    putStatus: putRes.status,
    putBody,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = req.body || {};
  const { bookingId, newStartDate, newEndDate, skipValidation = false } = body;

  // ── Validate input ────────────────────────────────────────────────────────
  if (!bookingId) {
    return res.status(400).json({ error: 'Missing required param: bookingId (UUID).' });
  }
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

  try {
    const token = await getOdinToken();

    // ── 1. Fetch booking (always needed for validation and reference) ─────────
    const booking = await getBookingByUUID(token, bookingId);
    const bookingReference = booking.bookingReference ?? null;

    // ── 2. Validation (unless skipValidation) ─────────────────────────────────
    if (!skipValidation) {
      const validation = quickValidate(booking, newStart, newEnd);
      if (!validation.valid) {
        return res.status(422).json({
          success: false,
          bookingId,
          bookingReference,
          reason:  validation.reason,
          message: validation.message,
        });
      }
    }

    // ── 3. Convert dates to ISO strings ───────────────────────────────────────
    const rentalFromISO = new Date(newStart).toISOString();
    const rentalToISO   = new Date(newEnd).toISOString();

    // ── 4. Call Odin ──────────────────────────────────────────────────────────
    const result = await callOdinUpdate(token, bookingId, rentalFromISO, rentalToISO);

    if (!result.ok) {
      console.error('[execute-date-change] Both PUT and PATCH failed', {
        bookingId,
        putStatus:   result.putStatus,
        patchStatus: result.status,
        patchData:   result.data,
      });
      return res.status(502).json({
        success:        false,
        bookingId,
        bookingReference,
        error:          'Failed to update rental period in Odin.',
        details:        result.data,
        putStatus:      result.putStatus,
        patchStatus:    result.status,
      });
    }

    return res.status(200).json({
      success:          true,
      bookingId,
      bookingReference,
      newStartDate:     newStart,
      newEndDate:       newEnd,
      message:          `Rental period updated successfully. New dates: ${newStart} to ${newEnd}.`,
      odinResponse:     result.data,
      methodUsed:       result.method,
    });

  } catch (err) {
    console.error('[execute-date-change] Error:', err);
    return res.status(500).json({ error: 'Internal server error.', details: err.message });
  }
}
