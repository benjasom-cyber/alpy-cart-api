/**
 * @file _resend-voucher.js
 * @description Handler for POST /api/support?action=resend-voucher
 * (routed from the public /api/resend-voucher path via vercel.json rewrite).
 *
 * Resends an Alpy booking voucher via Odin's webhook.
 *
 * Accepted body (from the Zendesk "resend_voucher" custom action):
 * { bookingReference, customerName, customerEmail, customerLastName }
 * Only bookingReference is strictly required — customerEmail is resolved
 * automatically from the booking record if not supplied.
 *
 * NOTE (2026-07-03): mirrors the proven-working pattern used in production by
 * the SKIBOT ZAF app (see ODIN_INFRASTRUCTURE.md / api/resend-voucher.js) —
 * a direct POST to Odin's webhook. If bookingReference is given without a
 * known email, this first resolves the booking via the public,
 * unauthenticated GET /api/v2/booking/{ref} endpoint to find the customer's
 * real email.
 *
 * NOTE (2026-07-03, follow-up): a live test returned 401 Unauthorized (HTML
 * gateway page) from Odin when authenticating with only the
 * 'X-Webhook-Secret' header. ODIN_INFRASTRUCTURE.md documents the same
 * secret being sent as 'Authorization: Bearer <secret>' instead. Sending
 * BOTH header forms here so whichever one Odin's gateway actually expects
 * will be accepted, and to gather more evidence for the correct one.
 *
 * @author Alpy Support Team
 */

const ODIN_BASE = 'https://odin.alpy.com';
const WEBHOOK_SECRET = 's6Xubrfc46ZZ8JHvQiYn';

function customerField(booking, subKey) {
  return (
    booking?.customer?.[subKey] ||
    booking?.[`customer${subKey.charAt(0).toUpperCase()}${subKey.slice(1)}`] ||
    null
  );
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string' && req.body.trim()) {
    try { return JSON.parse(req.body); } catch (_) {}
  }
  return {};
}

async function lookupBookingByRef(ref) {
  const r = await fetch(`${ODIN_BASE}/api/v2/booking/${encodeURIComponent(ref)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

async function odinFetch(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (netErr) {
    return { ok: false, status: 0, networkError: netErr.message, raw: '', parsed: null };
  }
  let raw = '';
  try { raw = await response.text(); } catch (_) {}
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) {}
  return { ok: response.ok, status: response.status, networkError: null, raw, parsed };
}

export async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const body = parseBody(req);
  const { bookingReference } = body;
  let customerEmail = body.customerEmail;

  if (!bookingReference) {
    return res.status(400).json({ success: false, error: 'Missing bookingReference.' });
  }

  try {
    let resolvedRef = bookingReference.trim().toUpperCase();

    if (!customerEmail) {
      const booking = await lookupBookingByRef(resolvedRef);
      if (!booking) {
        return res.status(404).json({ success: false, error: 'No booking found for that reference.' });
      }
      resolvedRef = booking.bookingReference || resolvedRef;
      customerEmail = customerField(booking, 'email');
    }

    if (!customerEmail) {
      return res.status(400).json({ success: false, error: 'Could not determine the customer email for this booking.' });
    }

    const payload = {
      customerEmail,
      bookingReference: resolvedRef,
      reference: 'https://skisupport.zendesk.com',
    };

    console.log('[resend-voucher] ->', JSON.stringify(payload));

    const result = await odinFetch(`${ODIN_BASE}/webhook/voucher-resend`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET,
        'Authorization': `Bearer ${WEBHOOK_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    console.log('[resend-voucher] odin status:', result.status,
      '| network error:', result.networkError || 'none',
      '| raw:', result.raw.slice(0, 400));

    if (result.networkError) {
      return res.status(502).json({ success: false, error: 'Failed to reach Odin', details: result.networkError });
    }

    if (!result.ok) {
      const snippet = result.raw.slice(0, 300);
      return res.status(result.status || 502).json({
        success: false,
        error: 'Odin rejected the request.',
        odinStatus: result.status,
        odinMessage: result.parsed || snippet,
      });
    }

    return res.status(200).json({
      success: true,
      bookingreference: resolvedRef,
      message: `Voucher for booking ${resolvedRef} has been resent to ${customerEmail}.`,
      ...(result.parsed || {}),
    });
  } catch (err) {
    console.error('[resend-voucher] Error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error.', details: err.message });
  }
}
