/**
 * Shared helper: live pricing from Alpy's public core.alpy.com backend.
 *
 * Underscore-prefixed filename on purpose: Vercel does not create a
 * serverless function for files starting with "_" inside /api, so this
 * module doesn't count against the Hobby plan's 12-function limit — it's
 * imported as a plain JS module by generate-quote.js and large-group-quote.js.
 *
 * Why this replaces the old Odin-based pricing:
 *   odin.alpy.com is behind a firewall that blocks Vercel's cloud IPs, so any
 *   call to it from these functions always failed silently (pricingAvailable
 *   stayed false). core.alpy.com is the domain alpy.com's own frontend uses
 *   to price the cart — it has no such restriction and is public/no-auth.
 *
 *   Verified 02/07/2026: calling dynamic-price-info with a single Economy
 *   ski (definitionId 3) for 2 days returned total.amount = 4002 (40.02 EUR),
 *   matching the live alpy.com cart to the cent — remise en ligne + code
 *   promo SKI26 already applied server-side.
 */

const CORE_BASE = 'https://core.alpy.com';

/**
 * Fetch the real, final online total for a cart — Alpy's own online discount
 * and any promo code are already applied server-side, exactly like the
 * number shown on alpy.com's own cart page.
 *
 * @param {object} opts
 * @param {{id:number,name:string}} opts.shop - resolved shop (from shops_data.json)
 * @param {string} opts.startDate - YYYY-MM-DD
 * @param {string} opts.endDate - YYYY-MM-DD
 * @param {Array<{age:number|string, skill?:string, equipment?:string}>} opts.persons
 * @param {(age:number|string, skill?:string, equipment?:string) => number} opts.getDefinitionId
 *        - same PRODUCTS-table lookup already used to build the cart URL
 * @param {string} [opts.currency='EUR']
 * @param {string} [opts.countryCode='FR']
 * @param {string} [opts.promoCode]
 * @returns {Promise<null|{cheapestTotalPrice:number, pricePerPerson:number, currency:string, rentalDays:number, shopName:string, discountPercentage:?string}>}
 *          null on any failure — pricing is optional and must never break cart URL generation.
 */
export async function fetchLivePricing({
    shop,
    startDate,
    endDate,
    persons,
    getDefinitionId,
    currency = 'EUR',
    countryCode = 'FR',
    promoCode,
}) {
    try {
          // dynamic-price-info expects `person` as a STRING-INDEXED OBJECT, not an
      // array, and each person's `equipment` is itself a string-indexed object.
      // This is the exact shape captured live from alpy.com's own network call.
      const personObj = {};
          persons.forEach((p, i) => {
                  personObj[String(i)] = {
                            age: parseInt(p.age) || 35,
                            equipment: {
                                        '0': { definitionId: getDefinitionId(p.age, p.skill, p.equipment), accessories: {} },
                            },
                  };
          });

      const body = {
              shopId: shop.id,
              locale: 'en',
              customerCountry: countryCode,
              currency,
              rentalPeriod: { from: startDate, to: endDate },
              person: personObj,
              coupons: {},
              insurance: [],
              partnerPrefix: null,
      };
          // promoCodes is keyed starting at "1" (not "0") — also captured from the real call.
      if (promoCode) body.promoCodes = { '1': { code: promoCode } };

      const res = await fetch(`${CORE_BASE}/core/cart/dynamic-price-info`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
      });
          if (!res.ok) return null;

      const data = await res.json();
          const totalCents = data && data.total && data.total.amount;
          if (typeof totalCents !== 'number') return null;

      const rentalDays = Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000);
          const totalEur = totalCents / 100;

      return {
              cheapestTotalPrice: totalEur,
              pricePerPerson: persons.length > 0 ? Math.round((totalEur / persons.length) * 100) / 100 : totalEur,
              currency,
              rentalDays,
              shopName: shop.name,
              discountPercentage: data.discountPercentage || null,
      };
    } catch {
          return null; // Pricing is optional — never break the cart URL generation
    }
}

/**
 * Maps a shop's country field (as stored in shops_data.json) to the
 * ISO country code dynamic-price-info expects for `customerCountry`.
 */
export function countryToCode(country) {
    const map = { france: 'FR', austria: 'AT', switzerland: 'CH', italy: 'IT', germany: 'DE', spain: 'ES', andorra: 'AD' };
    return map[String(country).toLowerCase()] || 'FR';
}
