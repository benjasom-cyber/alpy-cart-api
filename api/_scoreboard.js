/**
 * GET /api/agent-scoreboard          the leaderboard: this month and season to date
 * GET /api/agent-scoreboard?refresh=YYYY-MM   recompute one month and store it
 *
 * WHY THIS EXISTS AS A STORE AND NOT A QUERY
 * ------------------------------------------
 * The conversion engine in _conversion.js answers for ONE month and needs most
 * of its 50-second budget to do it: it walks Zendesk tickets, hashes the
 * requesters, then asks BigQuery which of them booked. A season is six months
 * of that. A Vercel function has 60 seconds, so a season simply cannot be
 * computed while somebody waits for a page.
 *
 * So it is accumulated instead. Each month is computed once, written to Blob,
 * and never recomputed unless asked: a month that has ended cannot change,
 * apart from bookings still landing inside the 30-day attribution window, which
 * is why the nightly job revisits the previous month at the start of each month.
 * Season to date is then a sum over stored months and answers instantly.
 *
 * THE SEASON
 * ----------
 * May 1 → April 30, which is how the company's own BI already cuts it (see the
 * Metabase question "New Customers Who Rebooked in Their First Season"). A
 * season is labelled by the year it opens: May 2026 → April 2027 is "2026/27".
 *
 * WHAT A NUMBER MEANS
 * -------------------
 * `gmv_eur` is the value of the bookings, what the customer paid — not Alpy's
 * commission. It is credited to the agent who took the FIRST contact of that
 * month with that customer, whether or not they are the one who closed it, and
 * a booking counts if it lands within 30 days of that contact.
 *
 * That makes the figure a floor and not a ledger, and the dashboard says so:
 *  · a contact that reaches nobody, or a caller we cannot identify, carries no
 *    revenue at all;
 *  · a customer who would have booked anyway still counts;
 *  · agents differ hugely in how many contacts they are handed, so a ranking
 *    reads volume at least as much as it reads skill.
 * It is a fair comparison between agents only to the extent that they are handed
 * comparable work.
 */

import { handler as conversionHandler } from './_conversion.js';

const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();
const BLOB_TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();

const KEY = (season) => `support/scoreboard/${season}.json`;

/* --------------------------------------------------------------- the season */

/** Seasons run May→April. Returns e.g. "2026-27" for any month inside it. */
export function seasonOf(month) {
  const [y, m] = month.split('-').map(Number);
  const start = m >= 5 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Every month of a season up to and including `upTo`, oldest first. */
export function monthsOfSeason(season, upTo) {
  const start = parseInt(season.slice(0, 4), 10);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(start, 4 + i, 1));
    const m = d.toISOString().slice(0, 7);
    if (m > upTo) break;
    out.push(m);
  }
  return out;
}

/* -------------------------------------------------------------------- store */

async function readStore(season) {
  if (!BLOB_TOKEN) return null;
  try {
    const { list } = await import('@vercel/blob');
    const { blobs } = await list({ prefix: KEY(season), token: BLOB_TOKEN, limit: 1 });
    if (!blobs || !blobs.length) return null;
    const r = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function writeStore(season, doc) {
  if (!BLOB_TOKEN) return false;
  const { put } = await import('@vercel/blob');
  await put(KEY(season), JSON.stringify(doc), {
    access: 'public',
    token: BLOB_TOKEN,
    contentType: 'application/json',
    allowOverwrite: true,
    addRandomSuffix: false,
  });
  return true;
}

/* ------------------------------------------------------------- computation */

/**
 * One month, through the existing engine. Calling the handler with a synthetic
 * req/res rather than exporting its internals is deliberate: the conversion
 * logic stays in exactly one place, and this file cannot drift away from what
 * the /api/metrics-conversion endpoint reports.
 */
async function conversionForMonth(month) {
  let payload = null;
  const req = { query: { month, secret: METRICS_SECRET }, headers: {} };
  const res = {
    setHeader() {},
    status() { return this; },
    json(o) { payload = o; return this; },
  };
  await conversionHandler(req, res);
  return payload;
}

/** The per-agent slice worth keeping. Everything else is recomputable noise. */
function sliceOf(month, conv) {
  if (!conv || conv.ok === false) return null;
  return {
    month,
    generated_at: conv.generated_at,
    truncated: !!conv.truncated,
    contacts: conv.contacts ? conv.contacts.requesters : null,
    agents: (conv.agents || []).map((a) => ({
      agent_id: a.agent_id,
      name: a.name,
      contacts: a.contacts,
      gmv_eur: a.revenue_eur,
      presale_converted: a.presale_converted,
      repeat_rebooked: a.repeat_rebooked,
    })),
  };
}

/* ------------------------------------------------------------- aggregation */

function leaderboard(slices) {
  const by = new Map();
  for (const s of slices) {
    for (const a of s.agents) {
      let v = by.get(a.agent_id);
      if (!v) by.set(a.agent_id, v = {
        agent_id: a.agent_id, name: a.name,
        contacts: 0, gmv_eur: 0, presale_converted: 0, repeat_rebooked: 0,
      });
      if (a.name && !/^\d+$/.test(a.name)) v.name = a.name;
      v.contacts += a.contacts || 0;
      v.gmv_eur += a.gmv_eur || 0;
      v.presale_converted += a.presale_converted || 0;
      v.repeat_rebooked += a.repeat_rebooked || 0;
    }
  }
  const rows = [...by.values()].map((v) => ({
    ...v,
    gmv_eur: Math.round(v.gmv_eur * 100) / 100,
    gmv_per_contact_eur: v.contacts ? Math.round((v.gmv_eur / v.contacts) * 100) / 100 : null,
  })).sort((x, y) => y.gmv_eur - x.gmv_eur);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

const sum = (rows, f) => rows.reduce((n, r) => n + (f(r) || 0), 0);

/* ----------------------------------------------------------------- handler */

export async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const fromCron = !!req.headers['x-vercel-cron'];
  if (METRICS_SECRET && !fromCron) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!BLOB_TOKEN) {
    return res.status(200).json({
      ok: false,
      error: 'no store',
      detail: 'BLOB_READ_WRITE_TOKEN is not set, so months cannot be accumulated. '
            + 'Connect the Blob store to this project with the read-write token option enabled.',
    });
  }

  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);

  /* ---- refresh path: compute one month and store it -------------------- */
  // The cron picks the month itself: at the very start of a month the previous
  // one still moves, because bookings keep landing inside its 30-day window,
  // and the new one is nearly empty. One month per invocation, because one
  // month is what fits in the time a function is given.
  let refresh = String(req.query.refresh || '').trim();
  if (fromCron && !refresh) {
    const dom = now.getUTCDate();
    refresh = dom <= 3
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
      : thisMonth;
  }

  if (refresh) {
    if (!/^\d{4}-\d{2}$/.test(refresh)) {
      return res.status(400).json({ ok: false, error: 'refresh must be YYYY-MM' });
    }
    const season = seasonOf(refresh);
    const conv = await conversionForMonth(refresh);
    const slice = sliceOf(refresh, conv);
    if (!slice) {
      return res.status(200).json({
        ok: false, refreshed: refresh,
        error: 'the conversion engine returned nothing usable',
        detail: conv && conv.error ? conv.error : null,
        missing: conv && conv.missing ? conv.missing : null,
      });
    }
    const doc = (await readStore(season)) || { season, months: {} };
    doc.months[refresh] = slice;
    doc.updated_at = new Date().toISOString();
    await writeStore(season, doc);
    return res.status(200).json({
      ok: true, refreshed: refresh, season,
      agents: slice.agents.length,
      gmv_eur: Math.round(sum(slice.agents, (a) => a.gmv_eur) * 100) / 100,
      truncated: slice.truncated,
      months_stored: Object.keys(doc.months).sort(),
    });
  }

  /* ---- read path: this month, and the season to date ------------------- */
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : thisMonth;
  const season = String(req.query.season || seasonOf(month));
  const doc = await readStore(season);

  if (!doc || !Object.keys(doc.months || {}).length) {
    return res.status(200).json({
      ok: true, season, month,
      empty: true,
      detail: 'no month has been computed for this season yet. '
            + 'Call ?refresh=YYYY-MM once per month to fill it, or wait for the nightly job.',
      month_board: [], season_board: [],
    });
  }

  const wanted = monthsOfSeason(season, month);
  const stored = wanted.filter((m) => doc.months[m]);
  const missing = wanted.filter((m) => !doc.months[m]);

  const monthSlice = doc.months[month] ? [doc.months[month]] : [];
  const monthBoard = leaderboard(monthSlice);
  const seasonBoard = leaderboard(stored.map((m) => doc.months[m]));

  return res.status(200).json({
    ok: true,
    season,
    month,
    generated_at: doc.updated_at,
    month_generated_at: doc.months[month] ? doc.months[month].generated_at : null,
    // Honesty about coverage: a season board built from four of six months is
    // not a season board, and the page has to be able to say which months are
    // missing rather than quietly under-reporting somebody's year.
    months_stored: stored,
    months_missing: missing,
    complete: missing.length === 0,
    month_board: monthBoard,
    season_board: seasonBoard,
    totals: {
      month_gmv_eur: Math.round(sum(monthBoard, (r) => r.gmv_eur) * 100) / 100,
      season_gmv_eur: Math.round(sum(seasonBoard, (r) => r.gmv_eur) * 100) / 100,
      month_contacts: sum(monthBoard, (r) => r.contacts),
      season_contacts: sum(seasonBoard, (r) => r.contacts),
    },
    note: 'gmv_eur is booking value, not commission. Credited to the agent who took '
        + 'the first contact of the month with that customer; a booking counts within '
        + '30 days of it.',
  });
}

export default handler;
