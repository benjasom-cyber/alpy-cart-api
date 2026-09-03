/**
 * GET /api/phone-index            (via /api/support?action=phone-index)
 * GET /api/phone-index?run=1      build / refresh (cron + manual)
 *
 * THE PHONE BRIDGE: ZENDESK TALK ON ONE SIDE, ODIN ON THE OTHER.
 *
 * The problem this solves
 * ----------------------
 * The conversion measurement joins Zendesk requesters to the BI booking table on
 * md5(email). A caller who never wrote to us has no email anywhere in Zendesk —
 * Talk knows only the number that rang. Those contacts fell out of the
 * measurement entirely, which is why `phone_coverage` existed: a hole, counted.
 *
 * Neither side can close it on its own:
 *   · `dbt_prod_bi.base_bookings_agg_booking` has no phone column at all
 *     (checked, 2026-09-03: the table has customer_email_hash and nothing else
 *     that identifies a person).
 *   · Odin's booking search filters on customerEmail / customerName /
 *     bookingReference. There is no phone filter, so a number cannot be looked
 *     up directly.
 *
 * What Odin DOES give, on every booking in the search result, is
 * `customer.phone = {countryCode, nationalNumber}` next to `customer.email`.
 * So the bridge is built the other way round: walk the bookings once, keep only
 *
 *     md5(E.164 number).slice(0,12)  ->  md5(email).slice(0,12)
 *
 * and nothing else. Both sides of the pair are fingerprints; no address and no
 * number is stored. The email fingerprint is exactly the key the BI table is
 * joined on, so a resolved caller drops straight into the existing conversion
 * pipeline with no second query.
 *
 * Where it lives
 * --------------
 * Vercel Blob when BLOB_READ_WRITE_TOKEN is set — one store, one JSON object,
 * read on demand and cached on the warm lambda. Without the token the index
 * still builds and still works for the life of a warm instance, and the endpoint
 * says so in `store: "memory"` rather than pretending to persist. That is the
 * one thing to set up for this to survive a cold start.
 *
 * Cost
 * ----
 * A day of bookings is a handful of 100-row pages, so the nightly refresh is
 * seconds. The backfill is the expensive part and is deliberately chunked: call
 * with ?run=1&from=YYYY-MM-DD&days=N and it walks N days from that date, stops
 * on its own budget, and reports where it got to in `next_from` so the next call
 * resumes there. Nothing is lost if it is interrupted.
 */

import crypto from 'node:crypto';
import { getOdinToken } from './_odin-auth.js';

const ODIN_BASE = 'https://odin.alpy.com';
const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();
const BLOB_TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
const BLOB_KEY = 'support/phone-index.json';

const BUDGET_MS = 50000;

/** Warm-instance copy. Also the whole store when there is no Blob token. */
const MEM = globalThis.__phoneIndex || (globalThis.__phoneIndex = {
  map: null,          // { phoneHash12: emailHash12 }
  meta: null,         // { built_at, days_walked, pairs, last_day }
  loadedAt: 0,
});
const MEM_TTL_MS = 10 * 60 * 1000;

const md5 = (s) => crypto.createHash('md5').update(String(s).trim().toLowerCase(), 'utf8').digest('hex');

/**
 * One number, one key. Talk sends E.164 ("+33618769344"); Odin sends the country
 * code and the national number apart. Both reduce to the same digit string.
 *
 * The 9-digit tail is kept as a second key on purpose: a number typed into a
 * booking form with a national trunk prefix ("0618769344") and the same number
 * seen by Talk in E.164 differ only in that prefix, and nine digits is long
 * enough that a collision inside one account's customer base is not a real risk.
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

/* ------------------------------------------------------------------ storage */

async function blobRead() {
  if (!BLOB_TOKEN) return null;
  const { list } = await import('@vercel/blob');
  const { blobs } = await list({ prefix: BLOB_KEY, token: BLOB_TOKEN, limit: 1 });
  if (!blobs || !blobs.length) return null;
  const r = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!r.ok) return null;
  return await r.json();
}

async function blobWrite(payload) {
  if (!BLOB_TOKEN) return false;
  const { put } = await import('@vercel/blob');
  await put(BLOB_KEY, JSON.stringify(payload), {
    access: 'public',
    token: BLOB_TOKEN,
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return true;
}

/**
 * The index, ready to look up. Callers that only need `resolve` should use this
 * rather than the handler: it is a plain object and a warm lambda answers from
 * memory.
 */
export async function loadIndex() {
  if (MEM.map && Date.now() - MEM.loadedAt < MEM_TTL_MS) return MEM;
  try {
    const j = await blobRead();
    if (j && j.map) {
      MEM.map = j.map;
      MEM.meta = j.meta || null;
      MEM.loadedAt = Date.now();
      return MEM;
    }
  } catch { /* a missing or unreadable index is not an error, just an empty one */ }
  if (!MEM.map) { MEM.map = {}; MEM.meta = null; }
  MEM.loadedAt = Date.now();
  return MEM;
}

/** phone (E.164 string or Odin's {countryCode, nationalNumber}) -> md5(email).slice(0,12) */
export function resolvePhone(index, phone) {
  const keys = phoneKeys(phone);
  for (const k of keys) {
    const hit = index && index.map ? index.map[k] : null;
    if (hit) return hit;
  }
  return null;
}

/* -------------------------------------------------------------------- odin */

async function odinBookingsOfDay(token, dayIso, deadline) {
  const pairs = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    if (Date.now() > deadline) return { pairs, pages, truncated: true };
    const p = new URLSearchParams({
      createdAtFrom: dayIso,
      createdAtTo: dayIso,
      limit: '100',
      offset: String(offset),
      orderBy: 'CREATED_AT_ASC',
    });
    const r = await fetch(ODIN_BASE + '/api/v2/booking/search?' + p, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (!r.ok) throw new Error('Odin ' + r.status + ' on booking/search');
    const j = await r.json();
    const list = j.bookings || j.data || (Array.isArray(j) ? j : []);
    pages++;
    for (const b of list) {
      const c = b && b.customer;
      if (!c || !c.email || !c.phone) continue;
      const keys = phoneKeys(c.phone);
      if (!keys.length) continue;
      const em = md5(c.email).slice(0, 12);
      for (const k of keys) pairs.push([k, em]);
    }
    if (!j.hasMore || j.nextOffset == null || !list.length) break;
    offset = j.nextOffset;
    if (pages > 60) break;   // one day should never need six thousand bookings
  }
  return { pairs, pages, truncated: false };
}

const dayIso = (ms) => new Date(ms).toISOString().slice(0, 10);

/* ----------------------------------------------------------------- handler */

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // The cron calls this with Vercel's own header; a human calls it with the
  // metrics secret. Either is enough, neither is optional.
  const fromCron = !!req.headers['x-vercel-cron'];
  if (METRICS_SECRET && !fromCron) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const run = req.query.run === '1' || req.query.run === 'true' || fromCron;

  if (!run) {
    const idx = await loadIndex();
    return res.status(200).json({
      ok: true,
      store: BLOB_TOKEN ? 'blob' : 'memory',
      pairs: Object.keys(idx.map || {}).length,
      meta: idx.meta,
    });
  }

  const deadline = Date.now() + BUDGET_MS;

  // Yesterday by default — that is the nightly job. A backfill passes `from` and
  // `days` and walks forward from there.
  const days = Math.min(120, Math.max(1, parseInt(req.query.days, 10) || 1));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))
    ? String(req.query.from)
    : dayIso(Date.now() - 86400000 * days);

  let token;
  try {
    token = await getOdinToken();
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'odin auth: ' + String(e && e.message).slice(0, 160) });
  }

  const idx = await loadIndex();
  const map = idx.map || (idx.map = {});
  const before = Object.keys(map).length;

  let walked = 0, added = 0, pagesTotal = 0, stoppedAt = null, failed = null;
  const startMs = Date.parse(from + 'T00:00:00Z');

  for (let i = 0; i < days; i++) {
    const d = dayIso(startMs + i * 86400000);
    if (Date.now() > deadline) { stoppedAt = d; break; }
    try {
      const { pairs, pages, truncated } = await odinBookingsOfDay(token, d, deadline);
      pagesTotal += pages;
      for (const [k, em] of pairs) { if (map[k] !== em) { map[k] = em; added++; } }
      walked++;
      if (truncated) { stoppedAt = d; break; }
    } catch (e) {
      failed = { day: d, error: String((e && e.message) || e).slice(0, 160) };
      stoppedAt = d;
      break;
    }
  }

  const meta = {
    built_at: new Date().toISOString(),
    last_run_from: from,
    last_run_days: walked,
    // Where a backfill should pick up next. Null once the requested span is done.
    next_from: stoppedAt || null,
    pairs: Object.keys(map).length,
    covered_through: idx.meta && idx.meta.covered_through && idx.meta.covered_through > dayIso(startMs + (walked - 1) * 86400000)
      ? idx.meta.covered_through
      : dayIso(startMs + Math.max(0, walked - 1) * 86400000),
  };
  idx.meta = meta;
  idx.loadedAt = Date.now();

  let persisted = false;
  try { persisted = await blobWrite({ map, meta }); } catch { persisted = false; }

  return res.status(200).json({
    ok: !failed,
    store: BLOB_TOKEN ? (persisted ? 'blob' : 'blob_write_failed') : 'memory',
    // Without a Blob store the index dies with the lambda. Said plainly rather
    // than left for someone to discover when the numbers quietly stop moving.
    warning: BLOB_TOKEN ? undefined
      : 'BLOB_READ_WRITE_TOKEN is not set: the index lives only in this instance and is lost on a cold start.',
    days_walked: walked,
    days_requested: days,
    pages_read: pagesTotal,
    pairs_added: added,
    pairs_before: before,
    pairs_total: Object.keys(map).length,
    next_from: stoppedAt,
    failed,
    meta,
  });
}

export default handler;
