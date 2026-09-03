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
import { loadIndex, resolvePhone } from './_phone-index.js';

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
  // L'agent qui a pris le PREMIER ticket du mois pour ce demandeur. C'est lui
  // qui portera la vente : attribuer au dernier reviendrait à créditer celui qui
  // a clôturé plutôt que celui qui a répondu.
  const firstAgent = new Map();     // requester_id -> assignee_id (string) | 'unassigned'
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
      if (prev == null || c < prev) {
        firstContact.set(k, c);
        firstAgent.set(k, t.assignee_id ? String(t.assignee_id) : 'unassigned');
      }
    }
    const last = batch.length ? Date.parse(batch[batch.length - 1].generated_timestamp * 1000 || batch[batch.length - 1].updated_at) : 0;
    if (d.end_of_stream || !d.next_page || last > b.end + 2 * 86400000) break;
    url = d.next_page;
  }
  return { firstContact, firstAgent, pages, tickets: seen, truncated };
}

/**
 * Les adresses des demandeurs, hachées immédiatement : rien d'autre n'en sort.
 * On garde aussi, par empreinte, l'agent du premier ticket, pour pouvoir dire
 * plus loin quelle vente suit quel agent.
 */
async function hashRequesters(ids, firstAgent, deadline) {
  const byHash = new Map();      // md5 -> premier contact (ms)
  const agentOf = new Map();     // md5 -> assignee_id
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
      if (prev == null || (c != null && c < prev)) {
        byHash.set(h, c);
        const a = firstAgent && firstAgent.get(u.id);
        if (a) agentOf.set(h, a);
      }
    }
  }
  return { byHash, agentOf, withEmail, calls };
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

/**
 * LES APPELS DU MOIS, ET LEUR RATTRAPAGE PAR LE NUMÉRO.
 *
 * Avant : un appelant sans adresse connue de Zendesk était perdu pour la mesure,
 * et `phone_coverage` se contentait de chiffrer le trou. Maintenant l'index
 * construit depuis Odin (voir _phone-index.js) rend le numéro à une empreinte
 * d'email — la même clé que la table BI — et l'appel rejoint la jointure.
 *
 * Ce qui circule reste une empreinte de part et d'autre : le numéro est haché
 * avant d'être cherché, et ce qui en ressort est un md5 d'adresse, jamais
 * l'adresse.
 */
async function phoneCoverage(b, existingHashes, index, deadline) {
  let url = '/api/v2/channels/voice/stats/incremental/calls.json?start_time=' + Math.floor(b.start / 1000);
  let inbound = 0, withTicket = 0, withNumber = 0, pages = 0;
  const resolved = new Map();   // md5(email).slice(0,12) -> premier appel (ms)
  const agentOf = new Map();    // même clé -> agent qui a pris l'appel
  while (url) {
    if (Date.now() > deadline) break;
    const d = await zd(url);
    pages++;
    const batch = d.calls || [];
    for (const c of batch) {
      const t = Date.parse(c.created_at);
      if (!(t >= b.start && t < b.end) || c.direction !== 'inbound') continue;
      inbound++;
      if (c.ticket_id) withTicket++;
      const num = c.customer_requester_id ? null : (c.phone_number || c.customer_phone || null);
      if (!num) continue;
      withNumber++;
      const h = index ? resolvePhone(index, num) : null;
      if (!h) continue;
      const prev = resolved.get(h);
      if (prev == null || t < prev) {
        resolved.set(h, t);
        if (c.agent_id) agentOf.set(h, String(c.agent_id));
      }
    }
    const last = batch.length ? Date.parse(batch[batch.length - 1].updated_at || batch[batch.length - 1].created_at) : 0;
    if (d.end_of_stream || !d.next_page || last > b.end + 2 * 86400000) break;
    url = d.next_page;
  }

  // Ceux que la jointure par email tenait déjà ne sont pas un gain : on ne les
  // compte qu'une fois, et le chiffre annoncé est le vrai gain net.
  let added = 0;
  for (const h of resolved.keys()) if (!existingHashes.has(h)) added++;

  return {
    coverage: {
      inbound_calls: inbound,
      with_ticket: withTicket,
      with_number: withNumber,
      matched_in_odin_index: resolved.size,
      newly_joinable: added,
      unjoinable: Math.max(0, inbound - withTicket - added),
      coverage_pct: pct(withTicket + added, inbound),
      index_pairs: index && index.map ? Object.keys(index.map).length : 0,
      index_built_at: index && index.meta ? index.meta.built_at : null,
      pages_read: pages,
    },
    resolved,
    agentOf,
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
    const { firstContact, firstAgent, pages, tickets, truncated } = await ticketsOfMonth(b, deadline);
    const ids = [...firstContact.entries()];
    const { byHash, agentOf, withEmail } = await hashRequesters(ids, firstAgent, deadline - 20000);

    // ── Une seule population, en clés de 12 hexadécimaux ─────────────────────
    // C'est la clé que la table BI expose (SUBSTR(customer_email_hash,4,12)), et
    // c'est aussi celle que l'index téléphone stocke : email et téléphone se
    // rejoignent donc naturellement, sans convertir quoi que ce soit deux fois.
    const contactAt = new Map();     // h12 -> premier contact (ms)
    const contactAgent = new Map();  // h12 -> agent
    const fromEmail = new Set();
    for (const [h, ms] of byHash.entries()) {
      const h12 = h.slice(0, 12);
      fromEmail.add(h12);
      const prev = contactAt.get(h12);
      if (prev == null || ms < prev) {
        contactAt.set(h12, ms);
        const a = agentOf.get(h);
        if (a) contactAgent.set(h12, a);
      }
    }

    // ── Le téléphone, rattrapé par l'index Odin ──────────────────────────────
    let index = null;
    try { index = await loadIndex(); } catch { index = null; }
    const phone = await phoneCoverage(b, fromEmail, index, deadline - 4000);
    for (const [h12, ms] of phone.resolved.entries()) {
      const prev = contactAt.get(h12);
      if (prev == null || ms < prev) {
        contactAt.set(h12, ms);
        if (!contactAgent.has(h12)) {
          const a = phone.agentOf.get(h12);
          if (a) contactAgent.set(h12, a);
        }
      }
    }

    const entries = [...contactAt.entries()];
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

    // Par agent : le même partage avant-vente / réachat, mais rattaché à celui
    // qui a pris le contact. Un agent n'apparaît que s'il a touché un contact
    // joignable — la liste n'est pas un classement de tout le service.
    const perAgent = new Map();
    const agentBucket = (k) => {
      let v = perAgent.get(k);
      if (!v) perAgent.set(k, v = {
        agent_id: k, contacts: 0,
        presale_contacts: 0, presale_converted: 0, presale_revenue_eur: 0,
        repeat_contacts: 0, repeat_rebooked: 0, repeat_revenue_eur: 0,
      });
      return v;
    };
    for (const h12 of contactAt.keys()) {
      agentBucket(contactAgent.get(h12) || 'unassigned').contacts++;
    }

    for (const r of rows) {
      const h12 = String(r[0] || '');
      const beforeN = Number(r[1]) || 0;
      const afterN = Number(r[2]) || 0;
      const gmv = Number(r[3]) || 0;
      const a = agentBucket(contactAgent.get(h12) || 'unassigned');
      if (beforeN > 0) {
        presaleContacts--;             // ce contact n'était pas de l'avant-vente
        repeatContacts++;
        a.repeat_contacts++;
        if (afterN > 0) { repeatConverted++; repeatGmv += gmv; a.repeat_rebooked++; a.repeat_revenue_eur += gmv; }
      } else if (afterN > 0) {
        presaleConverted++; presaleGmv += gmv;
        a.presale_converted++; a.presale_revenue_eur += gmv;
      }
    }
    for (const a of perAgent.values()) {
      a.presale_contacts = Math.max(0, a.contacts - a.repeat_contacts);
      a.presale_revenue_eur = Math.round(a.presale_revenue_eur * 100) / 100;
      a.repeat_revenue_eur = Math.round(a.repeat_revenue_eur * 100) / 100;
      // La contribution au chiffre d'affaires, avant-vente et réachat réunis :
      // c'est le chiffre demandé, et c'est celui qui se compare d'un agent à
      // l'autre.
      a.revenue_eur = Math.round((a.presale_revenue_eur + a.repeat_revenue_eur) * 100) / 100;
      a.revenue_per_contact_eur = a.contacts ? Math.round((a.revenue_eur / a.contacts) * 100) / 100 : null;
    }
    const agents = [...perAgent.values()].sort((x, y) => y.revenue_eur - x.revenue_eur);

    // Les noms, un seul appel, seulement pour les agents qui apparaissent.
    const agentIds = agents.map(a => a.agent_id).filter(x => /^\d+$/.test(x)).slice(0, 80);
    if (agentIds.length && Date.now() < deadline) {
      try {
        const uj = await zd('/api/v2/users/show_many.json?ids=' + agentIds.join(','));
        const byId = {};
        for (const u of (uj.users || [])) byId[String(u.id)] = u.name;
        for (const a of agents) a.name = byId[a.agent_id] || a.agent_id;
      } catch { /* les noms sont un confort */ }
    }
    for (const a of agents) if (!a.name) a.name = a.agent_id === 'unassigned' ? 'Unassigned' : a.agent_id;

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
        // Combien de ces empreintes viennent d'un email, et combien d'un numéro
        // rendu à un client par l'index Odin. La seconde colonne est le gain de
        // cette version : ces contacts-là étaient invisibles avant.
        from_email: fromEmail.size,
        from_phone: entries.length - fromEmail.size,
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

      // Le réachat garde sa propre ligne : c'est un autre métier, et son taux ne
      // se mélange pas à celui de l'avant-vente.
      repeat: {
        contacts: repeatContacts,
        rebooked: repeatConverted,
        rebooking_rate_pct: pct(repeatConverted, repeatContacts),
        revenue_eur: Math.round(repeatGmv * 100) / 100,
      },

      // LE CHIFFRE D'AFFAIRES DU SUPPORT, tout compris.
      //
      // Les deux TAUX restent séparés — additionner un taux d'avant-vente et un
      // taux de réachat ne veut rien dire — mais l'ARGENT, lui, s'additionne :
      // une réservation qui suit un contact est une réservation qui suit un
      // contact, que le client soit nouveau ou déjà venu. C'est ce total qui
      // s'affiche en tête du tableau de bord, avec sa décomposition dessous.
      support_revenue: {
        total_eur: Math.round((presaleGmv + repeatGmv) * 100) / 100,
        presale_eur: Math.round(presaleGmv * 100) / 100,
        repeat_eur: Math.round(repeatGmv * 100) / 100,
        bookings: presaleConverted + repeatConverted,
        contacts: entries.length,
        revenue_per_contact_eur: entries.length
          ? Math.round(((presaleGmv + repeatGmv) / entries.length) * 100) / 100 : null,
      },

      agents,
      phone_coverage: phone.coverage,
    };

    if (!truncated && !partial) CACHE.set(key, { at: Date.now(), value });
    return res.status(200).json(value);
  } catch (e) {
    return res.status(200).json({ ok: false, month, error: String((e && e.message) || e).slice(0, 200) });
  }
}

export default handler;
