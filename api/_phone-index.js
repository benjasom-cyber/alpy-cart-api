/**
 * THE PHONE BRIDGE: ZENDESK TALK ON ONE SIDE, ODIN ON THE OTHER.
 *
 * The problem
 * -----------
 * Conversion joins Zendesk requesters to the BI booking table on md5(email).
 * A caller who never wrote to us has no email anywhere in Zendesk — Talk knows
 * only the number that rang — so those contacts fell out of the measurement.
 * Neither side closes the gap alone:
 *   · BigQuery has no phone column at all. Checked 2026-09-03 against
 *     INFORMATION_SCHEMA for both dbt_prod_bi and bq_dev: zero columns matching
 *     phone / tel / mobile. There is no plaintext email either, only
 *     customer_email_hash.
 *   · Odin has no phone filter and no phone lookup: booking_search filters on
 *     customerEmail / customerName / bookingReference, and the user endpoints
 *     are keyed by email or UUID.
 *
 * What Odin does carry, on every booking, is customer.phone next to
 * customer.email. So the bridge is built the other way round — walk the
 * bookings once, keep only
 *
 *     md5('+' + E164digits).slice(0,12)  ->  md5(email).slice(0,12)
 *
 * and nothing else. Both sides are fingerprints; no number and no address is
 * stored. The email fingerprint is exactly the key the BI table joins on, so a
 * resolved caller drops into the existing pipeline with no second query.
 *
 * Where the index comes from
 * --------------------------
 * It is a BUILD-TIME artefact, committed as public/phone-index.json, not
 * something this function fetches. That is deliberate, and it is what the
 * earlier draft of this file got wrong:
 *
 *   · This project's ODIN_CLIENT_SECRET no longer authenticates (invalid_client
 *     as of 2026-09-03 — /api/search-bookings fails the same way), so a runtime
 *     Odin call could not work even if it were a good idea.
 *   · A Vercel function has 60 seconds. Peak season is ~1,860 bookings a day;
 *     a season is six figures. That is not a request, it is a batch job.
 *   · Odin rate-limits booking_search per user, so the walk has to be paced —
 *     again, not something to do inside a page load.
 *
 * The index is rebuilt by tools/build-phone-index.md, which walks Odin through
 * the MCP and writes the JSON. Rebuild it when coverage matters; it is a plain
 * file in the repo, diffable and reviewable.
 */

import crypto from 'node:crypto';

const md5 = (s) => crypto.createHash('md5').update(String(s).trim().toLowerCase(), 'utf8').digest('hex');

/**
 * One number, one key. Talk sends E.164 ("+33618769344"); Odin sends the country
 * code and the national number apart. Both reduce to the same digit string.
 *
 * The 9-digit tail is kept as a second key on purpose: a number typed into a
 * booking form with a national trunk prefix ("0618769344") and the same number
 * seen by Talk in E.164 differ only in that prefix, and nine digits is long
 * enough that a collision inside one customer base is not a real risk.
 *
 * tools/build-phone-index.md derives its keys with this exact function. If you
 * change it here, rebuild the index — a mismatch fails silently, matching
 * nothing while looking perfectly healthy.
 */
export function phoneKeys(input) {
  let digits = '';
  if (input && typeof input === 'object') {
    const cc = String(input.countryCode || '').replace(/\D/g, '');
    const nn = String(input.nationalNumber || '').replace(/\D/g, '');
    if (!nn) return [];
    digits = cc + nn.replace(/^0+/, '');
  } else {
    digits = String(input || '').replace(/\D/g, '');
  }
  if (digits.length < 8) return [];
  const keys = [md5('+' + digits).slice(0, 12)];
  const tail = digits.slice(-9);
  if (tail.length === 9) keys.push('t' + md5(tail).slice(0, 11));
  return keys;
}

/* ------------------------------------------------------------------ loading */

let CACHE = null;

/**
 * The index, ready to look up. Reads the committed JSON once per lambda and
 * keeps it — 7k keys is a couple of hundred kilobytes, so this is cheap and
 * there is nothing to refresh within the life of an instance.
 *
 * A missing file is not an error: it means nobody has built the index yet, and
 * the caller degrades to email-only matching. `pairs: 0` says so honestly
 * rather than pretending the join worked.
 */
export async function loadIndex() {
  if (CACHE) return CACHE;
  try {
    const { readFile } = await import('node:fs/promises');
    const path = new URL('../public/phone-index.json', import.meta.url);
    const j = JSON.parse(await readFile(path, 'utf8'));
    CACHE = { map: j.map || {}, meta: { built_at: j.built_at, pairs: j.pairs, bookings_walked: j.bookings_walked, source: j.source } };
  } catch {
    CACHE = { map: {}, meta: null };
  }
  return CACHE;
}

/** phone (E.164 string or Odin's {countryCode, nationalNumber}) -> md5(email).slice(0,12) */
export function resolvePhone(index, phone) {
  for (const k of phoneKeys(phone)) {
    const hit = index && index.map ? index.map[k] : null;
    if (hit) return hit;
  }
  return null;
}

/* ----------------------------------------------------------------- handler */

/**
 * GET /api/phone-index — what the index holds. Read-only: there is no ?run=1
 * any more, because building is a batch job that lives outside the request path.
 */
export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();
  if (METRICS_SECRET) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const idx = await loadIndex();
  const pairs = Object.keys(idx.map).length;
  return res.status(200).json({
    ok: true,
    store: pairs ? 'static-file' : 'empty',
    pairs,
    built_at: idx.meta ? idx.meta.built_at : null,
    bookings_walked: idx.meta ? idx.meta.bookings_walked : null,
    source: idx.meta ? idx.meta.source : null,
    how_to_rebuild: 'tools/build-phone-index.md',
  });
}

export default handler;
