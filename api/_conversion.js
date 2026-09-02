/**
 * GET /api/metrics-conversion?month=YYYY-MM   (via /api/support?action=metrics-conversion)
 *
 * LE TAUX DE CONVERSION DU SUPPORT — combien de chiffre d'affaires suit un
 * contact avec nous, et quelle part de ce contact était de l'avant-vente.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LA CLÉ DE JOINTURE, ET POURQUOI ELLE NE FAIT SORTIR AUCUNE DONNÉE PERSONNELLE
 *
 * La table BI `dbt_prod_bi.base_bookings_agg_booking` (BigQuery, via Metabase)
 * ne contient AUCUN email en clair et AUCUN numéro de téléphone. Elle contient
 * `customer_email_hash`, et la forme de ce champ a été mesurée :
 *
 *     customer_email_hash = "<plateforme>-" + md5(email)
 *     ex.  AR-e85708201b747d0492dc42a5ab802a33
 *
 * Vérifié sur une réservation réelle (B8BUCE) : le md5 de l'email retourné par
 * l'API publique d'Odin reproduit exactement les 32 hexadécimaux du hash. La
 * plateforme (AR / SB) préfixe, d'où le SUBSTR(...,4).
 *
 * Conséquence heureuse : on hache l'email du demandeur Zendesk de notre côté et
 * on compare des hashs. Aucune adresse ne circule entre les deux systèmes, et la
 * requête envoyée à BigQuery ne contient que des empreintes.
 *
 * LES DEUX POPULATIONS, QU'IL NE FAUT PAS MÉLANGER
 *
 *   AVANT-VENTE   le client n'avait aucune réservation au moment du contact.
 *                 S'il réserve ensuite, le support a fait une vente.
 *   APRÈS-VENTE   le client avait déjà réservé. S'il réserve encore, c'est du
 *                 réachat — précieux, mais ce n'est pas le même métier.
 *
 * Le taux de conversion annoncé est celui de l'avant-vente. Le réachat est
 * compté à part, jamais additionné pour faire un plus joli chiffre.
 *
 * MESURE DE CONTRÔLE (1er-15 août 2026, faite à la main) : 200 tickets, 166
 * demandeurs avec une adresse, 11 connus de la base réservations. 157 contacts
 * d'avant-vente → 2 conversions, 889,60 € ; 3 réachats après contact →
 * 2 551,85 €. Et août n'est pas un mois creux : 430 réservations et 129 328 €
 * créés ce mois-là, la saison d'hiver se vend déjà. Le chiffre compte donc, avec
 * une réserve qui joue dans le sens de la sous-estimation : un contact du 15 août
 * n'avait que 17 de ses 30 jours d'attribution au moment de la mesure.
 *
 * LE TÉLÉPHONE
 *
 * Zendesk Talk donne le numéro appelant et le ticket créé ; le demandeur de ce
 * ticket porte le plus souvent une adresse, et l'appel retombe donc dans la
 * jointure par email. Pour l'appelant sans adresse connue, il n'y a rien à
 * joindre : la table BI n'a pas de colonne téléphone. La réponse renvoie
 * `phone_coverage` pour que ce trou soit chiffré plutôt que supposé. Le jour où
 * le modèle dbt exposera un `customer_phone_hash` (même recette, même absence de
 * donnée personnelle), la jointure téléphone se branchera ici en dix lignes.
 *
 * DEUX CHEMINS VERS METABASE, SELON CE QU'ON A LE DROIT DE CRÉER
 *
 * 1. LIEN PUBLIC (aucune clé, aucun droit d'admin) — le chemin par défaut.
 *    La question « Support conversion — jointure empreintes » porte toute la
 *    requête SQL ; on ne lui passe qu'un paramètre texte : la liste
 *    "empreinte|date de contact|fin de fenêtre". Son lien public est interrogé
 *    en GET. Rien de sensible ne transite : le paramètre ne contient que des
 *    empreintes md5 tronquées, et la question ne sait répondre que sur les
 *    empreintes qu'on lui donne — elle ne déverse jamais la base.
 *    Limite : une URL ne peut pas être infinie, donc les empreintes partent par
 *    paquets. C'est le seul coût de ce chemin.
 *
 * 2. CLÉ D'API (si un jour on en a une) — une seule requête POST, sans limite de
 *    taille, et les horodatages à la seconde plutôt qu'à la journée. Le code
 *    bascule tout seul dès que METABASE_API_KEY existe.
 *
 * CONFIGURATION
 *
 *   METABASE_URL           https://reports.alpy.com   (sans slash final)
 *   METABASE_PUBLIC_CARD   l'UUID du lien public de la question  ← chemin 1
 *   METABASE_API_KEY       une clé d'API Metabase                ← chemin 2
 *   METABASE_DB_ID         2  (utilisé seulement par le chemin 2)
 *
 * Sans rien de tout cela l'endpoint répond 200 avec `ok:false` et le nom de ce
 * qui manque — jamais une erreur muette.
 */

import crypto from 'node:crypto';

const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();

const MB_URL = String(process.env.METABASE_URL || 'https://reports.alpy.com').trim().replace(/\/+$/, '');
const MB_KEY = String(process.env.METABASE_API_KEY || '').trim();
const MB_CARD = String(process.env.METABASE_PUBLIC_CARD || '').trim();
const MB_DB = parseInt(process.env.METABASE_DB_ID || '2', 10);

/** Une URL de lien public reste raisonnable en dessous de ~6 000 caractères. */
const PUBLIC_CHUNK = 150;

const METRICS_SECRET = String(process.env.METRICS_SECRET || process.env.REVIEW_SECRET || '').trim();

const BUDGET_MS = 50000;
/** Fenêtre d'attribution : une réservation compte si elle suit le contact de ≤ N jours. */
const DEFAULT_ATTRIBUTION_DAYS = 30;

const CACHE = globalThis.__convCache || (globalThis.__convCache = new Map());

const md5 = (s) => crypto.createHash('md5').update(String(s).trim().toLowerCase(), 'utf8').digest('hex');

function zdAuth() {
  if (!ZD_SUB || !ZD_EMAIL || !ZD_TOKEN) return null;
  return 'Basic ' + Buffer.from(ZD_EMAIL + '/token:' + ZD_TOKEN).toString('base64');
}

async function zd(url, timeout) {
  const auth = zdAuth();
  if (!auth) throw new Error('Zendesk credentials are not configured');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 20000);
  try {
    const full = url.indexOf('http') === 0 ? url : 'https://' + ZD_SUB + '.zendesk.com' + url;
    const r = await fetch(full, { headers: { Authorization: auth, Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('Zendesk ' + r.status + ' on ' + full.split('?')[0]);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function metabaseSql(sql, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 25000);
  try {
    const r = await fetch(MB_URL + '/api/dataset', {
      method: 'POST',
      headers: { 'x-api-key': MB_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ database: MB_DB, type: 'native', native: { query: sql } }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('Metabase ' + r.status);
    const j = await r.json();
    if (j.status && j.status !== 'completed') throw new Error('Metabase ' + (j.error || j.status));
    return (j.data && j.data.rows) || [];
  } finally { clearTimeout(t); }
}

/**
 * Le chemin sans clé : le lien public de la question porte le SQL, on ne lui
 * passe que la liste d'empreintes. Une URL a une longueur utile limitée, donc
 * l'appelant découpe — c'est le seul prix à payer pour ne pas avoir de secret.
 */
async function metabasePublic(pairs, timeout) {
  const params = encodeURIComponent(JSON.stringify([{
    type: 'category',
    target: ['variable', ['template-tag', 'pairs']],
    value: pairs,
  }]));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout || 25000);
  try {
    const r = await fetch(MB_URL + '/api/public/card/' + MB_CARD + '/query/json?parameters=' + params,
      { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!r.ok) throw new Error('Metabase public ' + r.status);
    const j = await r.json();
    if (!Array.isArray(j)) throw new Error('Metabase public: ' + String(j && (j.error || j.message)).slice(0, 80));
    // /query/json renvoie des objets nommés, /api/dataset des tableaux : on
    // ramène les deux à la même forme pour que la suite ne s'en soucie pas.
    return j.map(row => [row.h, row.before_n, row.after_n, row.after_gmv]);
  } finally { clearTimeout(t); }
}

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month || '');
  if (!m) return null;
  return { start: Date.UTC(+m[1], +m[2] - 1, 1), end: Date.UTC(+m[1], +m[2], 1) };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 19);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const pct = (n, d) => (d ? Math.round((n * 1000) / d) / 10 : null);

/**
 * Tous les tickets du mois, via l'export incrémental (1000 par page) plutôt que
 * la recherche, qui plafonne et pagine mal.
 */
async function ticketsOfMonth(b, deadline) {
  let url = '/api/v2/incremental/tickets.json?start_time=' + Math.floor(b.start / 1000);
  const firstContact = new Map();   // requester_id -> premier contact du mois (ms)
  let pages = 0, seen = 0, truncated = false;

  while (url) {
    if (Date.now() > deadline) { truncated = true; break; }
    const d = await zd(url);
    pages++;
    const batch = d.tickets || [];
    for (const t of batch) {
      const c = Date.parse(t.created_at);
      if (!(c >= b.start && c < b.end)) continue;
      seen++;
      const k = t.requester_id;
      if (!k) continue;
      const prev = firstContact.get(k);
      if (prev == null || c < prev) firstContact.set(k, c);
    }
    const last = batch.length ? Date.parse(batch[batch.length - 1].generated_timestamp * 1000 || batch[batch.length - 1].updated_at) : 0;
    if (d.end_of_stream || !d.next_page || last > b.end + 2 * 86400000) break;
    url = d.next_page;
  }
  return { firstContact, pages, tickets: seen, truncated };
}

/** Les adresses des demandeurs, hachées immédiatement : rien d'autre n'en sort. */
async function hashRequesters(ids, deadline) {
  const byHash = new Map();      // md5 -> premier contact (ms)
  let withEmail = 0, calls = 0;
  for (let i = 0; i < ids.length; i += 100) {
    if (Date.now() > deadline) break;
    const slice = ids.slice(i, i + 100);
    const d = await zd('/api/v2/users/show_many.json?ids=' + slice.map(x => x[0]).join(','));
    calls++;
    const when = new Map(slice);
    for (const u of (d.users || [])) {
      if (!u.email) continue;
      withEmail++;
      const h = md5(u.email);
      const c = when.get(u.id);
      const prev = byHash.get(h);
      if (prev == null || (c != null && c < prev)) byHash.set(h, c);
    }
  }
  return { byHash, withEmail, calls };
}

/**
 * Une seule requête BigQuery, avec les empreintes en clé. `before_n` compte les
 * réservations antérieures au contact — c'est ce qui sépare l'avant-vente de
 * l'après-vente, et c'est comparé au vrai horodatage du contact, pas à une
 * frontière de mois.
 */
function buildSql(entries, attributionDays) {
  const pairs = entries.map(([h, ms]) => "STRUCT('" + h.slice(0, 12) + "' AS h, TIMESTAMP('" + iso(ms) + "') AS t)").join(',');
  return `WITH z AS (SELECT * FROM UNNEST([${pairs}]))
SELECT z.h,
  COUNTIF(TIMESTAMP(b.booking_created_at) < z.t) AS before_n,
  COUNTIF(TIMESTAMP(b.booking_created_at) >= z.t
          AND TIMESTAMP(b.booking_created_at) < TIMESTAMP_ADD(z.t, INTERVAL ${attributionDays} DAY)) AS after_n,
  ROUND(SUM(IF(TIMESTAMP(b.booking_created_at) >= z.t
          AND TIMESTAMP(b.booking_created_at) < TIMESTAMP_ADD(z.t, INTERVAL ${attributionDays} DAY),
          b.GMV_eur, 0)), 2) AS after_gmv
FROM z LEFT JOIN \`dbt_prod_bi.base_bookings_agg_booking\` b
  ON SUBSTR(b.customer_email_hash, 4, 12) = z.h
GROUP BY z.h
HAVING before_n > 0 OR after_n > 0`;
}

/** Les appels du mois, pour chiffrer ce que la jointure par email ne couvre pas. */
async function phoneCoverage(b, knownRequesters, deadline) {
  let url = '/api/v2/channels/voice/stats/incremental/calls.json?start_time=' + Math.floor(b.start / 1000);
  let inbound = 0, withTicket = 0, joinable = 0, pages = 0;
  while (url) {
    if (Date.now() > deadline) break;
    const d = await zd(url);
    pages++;
    const batch = d.calls || [];
    for (const c of batch) {
      const t = Date.parse(c.created_at);
      if (!(t >= b.start && t < b.end) || c.direction !== 'inbound') continue;
      inbound++;
      if (c.ticket_id) { withTicket++; if (knownRequesters) joinable++; }
    }
    const last = batch.length ? Date.parse(batch[batch.length - 1].updated_at || batch[batch.length - 1].created_at) : 0;
    if (d.end_of_stream || !d.next_page || last > b.end + 2 * 86400000) break;
    url = d.next_page;
  }
  return {
    inbound_calls: inbound,
    with_ticket: withTicket,
    // Un appel sans ticket n'a pas de demandeur, donc pas d'adresse, donc rien
    // à joindre tant que la table BI n'expose pas d'empreinte de numéro.
    unjoinable: inbound - withTicket,
    coverage_pct: pct(withTicket, inbound),
    pages_read: pages,
  };
}

export async function handler(req, res) {
  if (METRICS_SECRET) {
    const given = String(req.query.secret || req.headers['x-metrics-secret'] || '');
    if (given !== METRICS_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const now = new Date();
  const month = String(req.query.month || '').trim() || now.toISOString().slice(0, 7);
  const b = monthBounds(month);
  if (!b) return res.status(400).json({ ok: false, error: 'month must be YYYY-MM' });

  const attributionDays = Math.min(180, Math.max(1,
    parseInt(req.query.attribution_days, 10) || DEFAULT_ATTRIBUTION_DAYS));

  const missing = [];
  if (!zdAuth()) missing.push('ZENDESK_SUBDOMAIN / ZENDESK_EMAIL / ZENDESK_API_TOKEN');
  if (!MB_URL) missing.push('METABASE_URL');
  if (!MB_KEY && !MB_CARD) missing.push('METABASE_PUBLIC_CARD (ou METABASE_API_KEY)');
  if (missing.length) {
    return res.status(200).json({ ok: false, month, error: 'configuration manquante', missing });
  }

  const key = month + '|' + attributionDays;
  const hit = CACHE.get(key);
  const isCurrent = month === now.toISOString().slice(0, 7);
  if (hit && Date.now() - hit.at < (isCurrent ? 5 * 60 * 1000 : 30 * 60 * 1000)) {
    return res.status(200).json({ ...hit.value, cached: true });
  }

  const deadline = Date.now() + BUDGET_MS;
  try {
    const { firstContact, pages, tickets, truncated } = await ticketsOfMonth(b, deadline);
    const ids = [...firstContact.entries()];
    const { byHash, withEmail } = await hashRequesters(ids, deadline - 12000);

    const entries = [...byHash.entries()];
    let rows = [];
    let partial = false;
    if (entries.length) {
      if (MB_KEY) {
        // Avec une clé : une requête POST, pas de limite de taille, et les
        // horodatages à la seconde.
        const CHUNK = 2000;
        for (let i = 0; i < entries.length; i += CHUNK) {
          if (Date.now() > deadline) { partial = true; break; }
          rows = rows.concat(await metabaseSql(buildSql(entries.slice(i, i + CHUNK), attributionDays)));
        }
      } else {
        // Sans clé : le lien public, par paquets, à la journée près.
        for (let i = 0; i < entries.length; i += PUBLIC_CHUNK) {
          if (Date.now() > deadline) { partial = true; break; }
          const pairs = entries.slice(i, i + PUBLIC_CHUNK).map(([h, ms]) =>
            h.slice(0, 12) + '|' + day(ms) + '|' + day(ms + attributionDays * 86400000)).join(',');
          rows = rows.concat(await metabasePublic(pairs));
        }
      }
    }

    let presaleContacts = entries.length;
    let presaleConverted = 0, presaleGmv = 0;
    let repeatContacts = 0, repeatConverted = 0, repeatGmv = 0;

    for (const r of rows) {
      const beforeN = Number(r[1]) || 0;
      const afterN = Number(r[2]) || 0;
      const gmv = Number(r[3]) || 0;
      if (beforeN > 0) {
        presaleContacts--;             // ce contact n'était pas de l'avant-vente
        repeatContacts++;
        if (afterN > 0) { repeatConverted++; repeatGmv += gmv; }
      } else if (afterN > 0) {
        presaleConverted++; presaleGmv += gmv;
      }
    }

    const phone = await phoneCoverage(b, true, deadline);

    const value = {
      ok: true,
      month,
      generated_at: new Date().toISOString(),
      attribution_days: attributionDays,
      // De quoi savoir, en lisant la réponse, ce qu'elle vaut : le lien public
      // travaille à la journée, la clé d'API à la seconde.
      source: MB_KEY ? 'metabase_api_key' : 'metabase_public_link',
      precision: MB_KEY ? 'seconde' : 'jour',
      truncated: truncated || partial,
      pages_read: pages,

      contacts: {
        tickets,
        requesters: ids.length,
        with_email: withEmail,
        // Les demandeurs sans adresse (formulaires anonymes, certains appels) ne
        // peuvent pas être joints : ils sont hors du calcul, pas comptés comme
        // des échecs.
        hashed: entries.length,
      },

      // LE chiffre : le support comme canal de vente.
      presale: {
        contacts: presaleContacts,
        converted: presaleConverted,
        conversion_rate_pct: pct(presaleConverted, presaleContacts),
        revenue_eur: Math.round(presaleGmv * 100) / 100,
        revenue_per_contact_eur: presaleContacts
          ? Math.round((presaleGmv / presaleContacts) * 100) / 100 : null,
      },

      // Compté à part, jamais additionné au précédent.
      repeat: {
        contacts: repeatContacts,
        rebooked: repeatConverted,
        rebooking_rate_pct: pct(repeatConverted, repeatContacts),
        revenue_eur: Math.round(repeatGmv * 100) / 100,
      },

      phone_coverage: phone,
    };

    if (!truncated && !partial) CACHE.set(key, { at: Date.now(), value });
    return res.status(200).json(value);
  } catch (e) {
    return res.status(200).json({ ok: false, month, error: String((e && e.message) || e).slice(0, 200) });
  }
}

export default handler;
