/**
 * POST /api/cancel-bookings
 *
 * Cancel every booking the customer asked us to cancel - one, or several.
 *
 * WHY THIS EXISTS
 *
 * Until now a message naming more than one booking went to a human, on the
 * grounds that "our flows act on one booking at a time". That is a statement
 * about our plumbing, not about the customer's request, and on ticket 581832 it
 * meant a duplicate-booking message with an explicit instruction sat waiting for
 * someone to read it. A customer who clearly asks for two cancellations has
 * asked for two cancellations; the machine should do them.
 *
 * A Zendesk action flow cannot loop, so the loop lives here.
 *
 * IT DOES NOT REIMPLEMENT CANCELLATION
 *
 * It calls the existing cancel-booking handler once per reference, through its
 * own HTTP contract, with a small in-process adapter. Every check that endpoint
 * performs still runs, unchanged, on every booking. Copying its logic here would
 * have created a second cancellation path that drifts from the first - and the
 * day they disagree is the day someone's holiday is cancelled by the version
 * nobody was maintaining.
 *
 * THE TWO RULES THAT MAKE IT SAFE
 *
 * 1. All or nothing, decided BEFORE anything is cancelled. Every reference is
 *    first read from Odin and checked: it exists, it belongs to the requester,
 *    and it is not already cancelled. One failure and NOTHING is cancelled.
 *    Half-cancelling a duplicate pair - the exact case this was built for -
 *    would leave the customer worse off than if we had done nothing.
 *
 * 2. No retry, ever. A cancellation is a gateway call and a local write in
 *    sequence, so an error does not prove nothing happened. Retrying can refund
 *    twice. If a cancellation fails mid-list we stop, report precisely what went
 *    through and what did not, and a human finishes.
 */

const ODIN_BASE = 'https://odin.alpy.com';
const MAX_BOOKINGS = Math.min(Math.max(parseInt(process.env.CANCEL_MAX_BOOKINGS, 10) || 5, 1), 10);

const REF_SHAPE = /^B[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;

function normEmail(x) { return String(x || '').trim().toLowerCase(); }

/** Everything we need to decide, read straight from the source of truth. */
async function readBooking(ref) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(ref),
                          { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) return { ok: false, why: 'Odin ' + r.status };
    const b = await r.json();
    if (!b || !b.bookingReference) return { ok: false, why: 'not found' };
    return { ok: true, booking: b };
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 120) };
  } finally { clearTimeout(t); }
}

function ownerEmail(b) {
  return normEmail((b && b.customer && b.customer.email) || '');
}

function looksCancelled(b) {
  const s = String((b && (b.bookingStatus || b.status)) || '').toUpperCase();
  return s.indexOf('CANCEL') > -1;
}

/**
 * Call the single-booking endpoint in process.
 *
 * A tiny res shim: the handler writes its answer with res.status().json(), and
 * we want that answer as a value rather than as an HTTP response.
 */
async function cancelOne(cancelHandler, ref, customerEmail, reference) {
  const captured = { status: 0, body: null };
  const res = {
    setHeader() {},
    status(code) { captured.status = code; return this; },
    json(obj) { captured.body = obj; return obj; },
    send(x) { captured.body = x; return x; },
    end() { return undefined; },
  };
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    query: {},
    body: { bookingReference: ref, customerEmail, reference },
  };
  await cancelHandler(req, res);
  const ok = captured.status >= 200 && captured.status < 300;
  return { ok, status: captured.status, body: captured.body };
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST.' });
  }

  let params = req.body || {};
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }

  const customerEmail = normEmail(params.customerEmail || params.customeremail || params.email);
  const reference = String(params.reference || params.ticketUrl || '').slice(0, 300);

  // Accept a list, a comma-separated string, or a single reference - a flow
  // hands over whatever its previous step happened to produce.
  let raw = params.bookingReferences || params.bookingreferences ||
            params.refs || params.bookingReference || params.bookingreference || [];
  if (typeof raw === 'string') raw = raw.split(/[,;\s]+/);
  const refs = [...new Set((Array.isArray(raw) ? raw : [raw])
    .map(x => String(x || '').trim().toUpperCase())
    .filter(Boolean))];

  if (!customerEmail) {
    return res.status(400).json({ error: 'Missing customerEmail.' });
  }
  if (!refs.length) {
    return res.status(400).json({ error: 'Missing bookingReferences.' });
  }
  const malformed = refs.filter(r => !REF_SHAPE.test(r));
  if (malformed.length) {
    return res.status(400).json({ error: 'Not booking references: ' + malformed.join(', ') });
  }
  if (refs.length > MAX_BOOKINGS) {
    // Not a technical limit - a judgement one. Past a handful, a bulk
    // cancellation is a conversation, not a transaction.
    return res.status(200).json({
      ok: false, action: 'HANDOVER', cancelled: [], refused: refs,
      reason: refs.length + ' bookings in one request is above the automatic limit of ' +
              MAX_BOOKINGS + '. A human should confirm this with the customer.',
    });
  }

  // ── Phase 1: check everything, change nothing ────────────────────────────
  const checked = [];
  const blocked = [];
  for (const ref of refs) {
    const r = await readBooking(ref);
    if (!r.ok) { blocked.push({ ref, why: 'could not be read from Odin (' + r.why + ')' }); continue; }
    const owner = ownerEmail(r.booking);
    if (!owner) { blocked.push({ ref, why: 'no customer email on the booking' }); continue; }
    if (owner !== customerEmail) {
      // The single most important line in this file. The person writing to us
      // must be the person who owns every booking they are asking us to cancel.
      blocked.push({ ref, why: 'belongs to a different customer than the requester' });
      continue;
    }
    if (looksCancelled(r.booking)) { blocked.push({ ref, why: 'already cancelled' }); continue; }
    checked.push(ref);
  }

  if (blocked.length) {
    return res.status(200).json({
      ok: false, action: 'HANDOVER',
      cancelled: [], notCancelled: refs,
      blocked,
      reason: 'Nothing was cancelled. ' + blocked.length + ' of ' + refs.length +
              ' bookings did not pass the checks, and a partial cancellation would ' +
              'leave the customer worse off than no cancellation at all.',
    });
  }

  // ── Phase 2: cancel, in order, stopping at the first failure ─────────────
  const mod = await import('./cancel-booking.js');
  const cancelHandler = mod.default || mod.handler;
  if (typeof cancelHandler !== 'function') {
    return res.status(500).json({ error: 'cancel-booking handler not available' });
  }

  const cancelled = [];
  const failed = [];
  // Whatever the single-booking endpoint returned last. We hand its fields back
  // untouched so the existing custom action, whose declared outputs are the ones
  // that endpoint produces, keeps working when its URL is pointed here.
  let lastBody = null;
  for (const ref of checked) {
    let r;
    try {
      r = await cancelOne(cancelHandler, ref, customerEmail, reference);
    } catch (e) {
      r = { ok: false, status: 0, body: { error: String(e && e.message || e).slice(0, 200) } };
    }
    if (r.ok) { cancelled.push(ref); lastBody = r.body || lastBody; continue; }
    // No retry. See the header: an error is not proof that nothing happened.
    failed.push({ ref, status: r.status, detail: (r.body && (r.body.error || r.body.message)) || '' });
    break;
  }

  const notCancelled = checked.filter(r => cancelled.indexOf(r) === -1);

  const summaryText = failed.length === 0
    ? (cancelled.length === 1
        ? 'Booking ' + cancelled[0] + ' has been cancelled.'
        : 'Bookings ' + cancelled.join(', ') + ' have been cancelled.')
    : 'Cancelled: ' + (cancelled.join(', ') || 'none') + '. Stopped on ' + failed[0].ref +
      '. Do NOT retry automatically - check in Odin what actually went through before ' +
      'doing anything else, then finish by hand.';

  return res.status(200).json({
    // ── Backward-compatible fields ────────────────────────────────────────
    // The cancel_booking custom action declares exactly these outputs. Keeping
    // them means pointing its URL here changes nothing downstream: a flow that
    // cancels one booking behaves as it always did, and the same flow now also
    // handles two. Anything the single endpoint returned that we do not
    // override is passed through untouched.
    ...(lastBody && typeof lastBody === 'object' ? lastBody : {}),
    success: failed.length === 0,
    message: summaryText,
    bookingreference: cancelled.join(', '),
    bookingReference: cancelled.join(', '),

    // ── What is new ───────────────────────────────────────────────────────
    ok: failed.length === 0,
    action: failed.length === 0 ? 'DONE' : 'HANDOVER',
    cancelled,
    notCancelled,
    failed,
    count: cancelled.length,
    // Ready to paste into a public reply or an internal note by the caller.
    summary: summaryText,
  });
}

export default handler;
