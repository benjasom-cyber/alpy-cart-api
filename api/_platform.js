/**
 * WHICH SHOP FRONT THE CUSTOMER BOUGHT FROM.
 *
 * One core platform, a dozen brands: alpy.com, slopefox.co.uk, pistenfuchs.de,
 * skidiscount.fr ... Every brand serves the same cart URL shape -
 *   https://www.<domain>/<lang>/<segment>/products?shopId=N&cart=...
 * (verified 2026-09-03: the alpy.com cart link for shop 77, replayed on
 * www.slopefox.co.uk, redirected to the canonical Galtür page with the shop,
 * dates and person intact).
 *
 * Until now every cart link was minted on alpy.com. On 581942 a Slopefox
 * customer was therefore sent to a site she had never heard of, with another
 * brand's logo, to "confirm her booking". This module picks the domain, and the
 * two quote endpoints build their links on it.
 *
 * Two ways to know the brand, in order of trust:
 *
 *   1. The Zendesk brand of the ticket (`brand_id`) - where the customer wrote.
 *      Flows have it as workflow.input.brand_id; pass it as `platform`.
 *   2. The names of the booking's own services. The free cancellation cover is
 *      sold under one name per brand (SLOPEFLEX, PISTENFLEX, SNOWFLEX ...), so a
 *      booking carries its brand in plain text. Ambiguous names (SKIFLEXI is
 *      shared by four French/UK discount brands, Alpinflexi by alpy.com and
 *      Swissrent) resolve to nothing rather than to a guess.
 *
 * With neither, alpy.com - the historical default, and still the largest.
 */

const DEFAULT_DOMAIN = 'www.alpy.com';

// Zendesk brand id -> site domain. Ids from /api/v2/brands on skisupport.
const BRAND_ID_TO_DOMAIN = {
  '246961':         'www.alpy.com',
  '23016833469597': 'www.swissrent.com',
  '360000234758':   'www.snowbrainer.com',
  '360000232817':   'www.location-ski-moins-cher.com',
  '360000234878':   'www.best-price-ski-rental.com',
  '360000234818':   'www.skidiscount.fr',
  '360000306518':   'www.skidiscount.co.uk',
  '360000306598':   'www.skimarie.fr',
  '6898647504797':  'www.simplytoski.fr',
  '360000306498':   'www.slopefox.co.uk',
  '360000304717':   'www.pistenfuchs.de',
};

// A domain or brand word typed by hand -> domain. Lets a caller pass
// "slopefox", "slopefox.co.uk" or "https://www.slopefox.co.uk/..." alike.
const WORD_TO_DOMAIN = [
  [/slopefox/i,                       'www.slopefox.co.uk'],
  [/pistenfuchs/i,                    'www.pistenfuchs.de'],
  [/snowbrainer/i,                    'www.snowbrainer.com'],
  [/skimarie/i,                       'www.skimarie.fr'],
  [/simply\s*to\s*ski|simplytoski/i,  'www.simplytoski.fr'],
  [/skidiscount\.co\.uk/i,            'www.skidiscount.co.uk'],
  [/skidiscount/i,                    'www.skidiscount.fr'],
  [/location-ski-moins-cher/i,        'www.location-ski-moins-cher.com'],
  [/best-price-ski-rental/i,          'www.best-price-ski-rental.com'],
  [/swissrent/i,                      'www.swissrent.com'],
  [/alpy|alpinresorts/i,              'www.alpy.com'],
];

// Cancellation-cover / protection product name -> domain, ONLY where the name
// belongs to exactly one brand.
const SERVICE_TO_DOMAIN = [
  [/slope\s*flex|slope\s*guaranty/i,          'www.slopefox.co.uk'],
  [/pisten\s*flex|material\s*garantie/i,      'www.pistenfuchs.de'],
  [/snow\s*flex|snow\s*guaranty/i,            'www.snowbrainer.com'],
  [/marie\s*annulation|marie\s*assurance/i,   'www.skimarie.fr'],
  [/simply\s*annulation|simply\s*garantie/i,  'www.simplytoski.fr'],
];

/** Domain for an explicit platform hint: a Zendesk brand id, a domain, a brand word, or a URL. */
export function domainFromHint(hint) {
  const s = String(hint == null ? '' : hint).trim();
  if (!s) return null;
  if (BRAND_ID_TO_DOMAIN[s]) return BRAND_ID_TO_DOMAIN[s];
  for (const [rx, domain] of WORD_TO_DOMAIN) if (rx.test(s)) return domain;
  return null;
}

/** Domain read off a booking's own services / insurance names; null when ambiguous. */
export function domainFromBooking(booking) {
  const items = [].concat((booking && booking.insurance) || [], (booking && booking.services) || []);
  for (const item of items) {
    const name = String((item && (item.name || item.type)) || '');
    for (const [rx, domain] of SERVICE_TO_DOMAIN) if (rx.test(name)) return domain;
  }
  // Odin also hangs services off each equipment item.
  for (const eq of (booking && booking.equipment) || []) {
    for (const svc of (eq && eq.services) || []) {
      const name = String((svc && svc.name) || '');
      for (const [rx, domain] of SERVICE_TO_DOMAIN) if (rx.test(name)) return domain;
    }
  }
  return null;
}

/** The domain to build customer-facing links on. Hint first, booking second, alpy.com last. */
export function resolveDomain(hint, booking) {
  return domainFromHint(hint) || (booking ? domainFromBooking(booking) : null) || DEFAULT_DOMAIN;
}


/**
 * WHERE EACH BRAND PRICES ITS CART.
 *
 * Every brand's frontend calls its OWN core host - www.snowbrainer.com talks
 * to core.snowbrainer.com, not to core.alpy.com - and that host applies the
 * brand's own online discount. Measured 2026-09-04, shop 2494, one adult
 * 4* ski, 10-17/01/2027, promo SKI26, gross 133.00 EUR everywhere:
 *
 *     core.alpy.com                       40.00 %   79.80
 *     core.snowbrainer.com                39.70 %   80.20
 *     core.slopefox.co.uk / pistenfuchs.de / skimarie.fr
 *                                         39.50 %   80.47
 *     core.skidiscount.fr / .co.uk / location-ski-moins-cher.com /
 *     best-price-ski-rental.com           39.25 %   80.80
 *     core.simplytoski.fr                 40.20 %   79.53
 *
 * So a quote priced on core.alpy.com and sent with a snowbrainer.com cart link
 * is off by a few tenths of a percent - 389,76 announced, 391,84 in the basket
 * (581971). The haircut is not a fixed rule we could hard-code: it is whatever
 * the brand's core answers today. Price on the brand's own host, and the number
 * in the message is the number in the basket.
 *
 * swissrent.com runs on another platform (no core.swissrent.* answers), so it
 * falls back to core.alpy.com - the best figure we have, flagged as such.
 */
const CORE_HOSTS = {
  'www.alpy.com':                      'core.alpy.com',
  'www.snowbrainer.com':               'core.snowbrainer.com',
  'www.slopefox.co.uk':                'core.slopefox.co.uk',
  'www.pistenfuchs.de':                'core.pistenfuchs.de',
  'www.skidiscount.fr':                'core.skidiscount.fr',
  'www.skidiscount.co.uk':             'core.skidiscount.co.uk',
  'www.location-ski-moins-cher.com':   'core.location-ski-moins-cher.com',
  'www.best-price-ski-rental.com':     'core.best-price-ski-rental.com',
  'www.skimarie.fr':                   'core.skimarie.fr',
  'www.simplytoski.fr':                'core.simplytoski.fr',
};
const DEFAULT_CORE = 'https://core.alpy.com';

/** The pricing host for a site domain: "https://core.snowbrainer.com". alpy.com's when the brand has none. */
export function coreBase(domain) {
  const host = CORE_HOSTS[String(domain || '').toLowerCase()];
  return host ? 'https://' + host : DEFAULT_CORE;
}

/** True when the brand prices on its own core host (false = priced on alpy.com's, an approximation). */
export function hasOwnCore(domain) {
  return !!CORE_HOSTS[String(domain || '').toLowerCase()];
}

/** Brand label for prose ("slopefox.co.uk"), from a domain. */
export function brandLabel(domain) {
  return String(domain || DEFAULT_DOMAIN).replace(/^www\./, '');
}

export { DEFAULT_DOMAIN, BRAND_ID_TO_DOMAIN, CORE_HOSTS, DEFAULT_CORE };
