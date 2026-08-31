/**
 * POST /api/protection-upgrade   (served through /api/support?action=protection-upgrade)
 *
 * "I forgot to take AlpinGuaranty, how do I add it to BQTZCJ?"
 *
 * WHY THIS EXISTS
 *
 * A protection cannot be attached to a paid booking - the card cannot be
 * charged again. So the only true answer is: book again with the protection
 * included, and cancel the current booking. On 581843 and 581846 the flow said
 * exactly that, and stopped there: no cart, no figure, and a closing question
 * asking the customer to confirm before we would go and look anything up. That
 * is not an answer, it is a promise of an answer - and on the second round it
 * asked the customer to check the cancellation cost themselves.
 *
 * Both halves of the real answer are computable the moment we know the
 * reference. This endpoint computes them together:
 *
 *   1. THE CART. The existing booking, rebuilt identically - same shop, same
 *      dates, same equipment - with the protection included. The customer gets
 *      a link, not a description of a link.
 *   2. THE COST OF LEAVING. What cancelling the current booking would cost
 *      today, from its own dates and its own protections.
 *
 * With both, the reply is a decision the customer can take in one click. With
 * neither, it is a conversation that takes three days.
 *
 * WHAT IT NEVER DOES
 *
 * It never cancels anything. It reads, it prices, it returns. The cancellation
 * is a separate, explicit act that happens only after the customer says yes.
 */

const ODIN_BASE = 'https://odin.alpy.com';

const REF_SHAPE = /^B[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}$/;

function money(minor) {
  if (minor == null || isNaN(minor)) return null;
  return Math.round(Number(minor)) / 100;
}

function day(iso) {
  const s = String(iso || '');
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/**
 * Working days between today and the first rental day, Monday to Friday.
 *
 * Public holidays are NOT excluded, and that is stated in the output rather
 * than hidden: they differ by country and by shop, and a fee band that is one
 * day optimistic is a fee band that under-quotes the customer. Where the count
 * lands within one day of a band edge we say the figure needs confirming.
 */
function workingDaysUntil(startDay, nowIso) {
  const start = new Date(startDay + 'T00:00:00Z');
  const now = new Date(day(nowIso) + 'T00:00:00Z');
  if (isNaN(start) || isNaN(now)) return null;
  if (start <= now) return 0;
  let n = 0;
  const cur = new Date(now);
  while (cur < start) {
    const wd = cur.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

/**
 * The fee table, exactly as it is written in the knowledge book and on the
 * voucher. One place, one set of numbers.
 */
function feeBand(startDay, nowIso) {
  const today = day(nowIso);
  if (!startDay || !today) return null;
  if (today >= startDay) {
    return { percent: 100, band: 'on or after the first rental day', workingDays: 0 };
  }
  const wd = workingDaysUntil(startDay, nowIso);
  if (wd == null) return null;
  if (wd > 10) return { percent: 25, band: 'more than 10 working days before the start', workingDays: wd };
  if (wd >= 3)  return { percent: 30, band: '9 to 3 working days before the start',      workingDays: wd };
  return { percent: 35, band: '2 working days until 08:00 the day before', workingDays: wd };
}

/** Does the booking already carry the cancellation protection? */
function hasCancellationCover(booking) {
  const items = [].concat(booking.insurance || [], booking.services || []);
  return items.some(x => /flexi|annul|cancel/i.test(String((x && (x.name || x.type)) || '')));
}

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  let params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
  if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

  const ref = String(params.bookingReference || params.bookingreference || '').trim().toUpperCase();

  // No reference, no answer - and that is not an error worth breaking a flow
  // over. The general-questions flow calls this on every ticket that reaches
  // it, most of which have nothing to do with protections. A 200 with
  // applicable:false lets the step succeed and the prompt ignore it.
  if (!ref || !REF_SHAPE.test(ref)) {
    return res.status(200).json({
      applicable: false,
      reason: 'No booking reference was supplied, so there is nothing to rebuild.',
      cart_url: '', summary: '',
    });
  }

  try {
    const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(ref),
                          { headers: { Accept: 'application/json' } });
    if (!r.ok) {
      return res.status(200).json({
        applicable: false,
        reason: 'Booking ' + ref + ' could not be read from Odin (' + r.status + ').',
        cart_url: '', summary: '',
      });
    }
    const booking = await r.json();

    const startDay = day(booking.rentalPeriod && booking.rentalPeriod.from);
    const endDay = day(booking.rentalPeriod && booking.rentalPeriod.to);
    const paid = money(booking.total && booking.total.amount);
    const currency = (booking.total && booking.total.currency) || 'EUR';
    const alreadyCancelled = /CANCEL/i.test(String(booking.bookingStatus || booking.status || ''));

    // ── The cart, with the protection in it ──────────────────────────────────
    const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    let cartUrl = '';
    let newTotal = null;
    let quoteNote = '';
    try {
      const q = await fetch(proto + '://' + host + '/api/requote-booking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingReference: ref, insurance: true }),
      });
      const parsed = await q.json().catch(() => null);
      if (parsed && parsed.cartUrl) {
        cartUrl = parsed.cartUrl;
        newTotal = parsed.cartOnlinePrice != null ? parsed.cartOnlinePrice
                 : (parsed.cartonlineprice != null ? parsed.cartonlineprice : null);
      } else {
        quoteNote = 'The cart could not be rebuilt automatically; an agent has to prepare it.';
      }
    } catch (e) {
      quoteNote = 'The cart could not be rebuilt automatically (' +
                  String((e && e.message) || e).slice(0, 80) + ').';
    }

    // ── What leaving the current booking costs ───────────────────────────────
    const band = feeBand(startDay, new Date().toISOString());
    const flexi = hasCancellationCover(booking);
    let feeAmount = null;
    let feeText = '';

    if (alreadyCancelled) {
      feeText = 'Booking ' + ref + ' is already cancelled.';
    } else if (flexi) {
      // The cancellation protection is on the booking, so the fee question does
      // not arise - until 08:00 the day before, cancelling is free of charge.
      feeText = 'This booking carries the cancellation protection, so it can be cancelled ' +
                'free of charge until 08:00 on the day before the first rental day (' +
                startDay + ').';
    } else if (band && paid != null) {
      feeAmount = Math.round(paid * band.percent) / 100;
      feeText = 'Cancelling ' + ref + ' today falls in the "' + band.band + '" band: ' +
                band.percent + '% of ' + paid.toFixed(2) + ' ' + currency + ', i.e. about ' +
                feeAmount.toFixed(2) + ' ' + currency + ' kept, ' +
                (paid - feeAmount).toFixed(2) + ' ' + currency + ' refunded.';
      if (band.workingDays != null && (Math.abs(band.workingDays - 10) <= 1 || Math.abs(band.workingDays - 3) <= 1)) {
        feeText += ' The count sits close to a band edge and public holidays are not ' +
                   'counted here, so confirm the exact figure before quoting it as final.';
      }
    } else {
      feeText = 'The cancellation fee could not be computed for ' + ref + '.';
    }

    const summary = [
      'The protection cannot be added to ' + ref + '. The route is a new booking that ' +
      'includes it, plus cancellation of ' + ref + '.',
      cartUrl ? 'Ready cart with the protection included: ' + cartUrl +
                (newTotal != null ? ' (' + Number(newTotal).toFixed(2) + ' ' + currency + ' online)' : '')
              : quoteNote,
      feeText,
      'Nothing is cancelled until the customer says yes.',
    ].filter(Boolean).join(' ');

    return res.status(200).json({
      applicable: true,
      booking_reference: ref,
      shop_name: (booking.shop && booking.shop.name) || '',
      start_date: startDay,
      end_date: endDay,
      already_cancelled: alreadyCancelled,

      cart_url: cartUrl,
      new_total_online: newTotal,
      currency,

      current_paid: paid,
      has_cancellation_cover: flexi,
      cancellation_fee_percent: band ? band.percent : null,
      cancellation_fee_amount: feeAmount,
      cancellation_refund_amount: (paid != null && feeAmount != null)
        ? Math.round((paid - feeAmount) * 100) / 100 : null,
      cancellation_fee_text: feeText,
      cancellation_deadline: startDay ? '08:00 on the day before ' + startDay : '',

      summary,
    });
  } catch (e) {
    return res.status(200).json({
      applicable: false,
      reason: String((e && e.message) || e).slice(0, 160),
      cart_url: '', summary: '',
    });
  }
}

export default handler;
