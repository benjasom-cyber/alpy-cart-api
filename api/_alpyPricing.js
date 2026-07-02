/**
 * Shared helper: live pricing from Alpy's public core.alpy.com backend.
 *
 * Underscore-prefixed filename on purpose: Vercel does not create a
 * serverless function for files starting with "_" inside /api, so this
 * module doesn't count against the Hobby plan's 12-function limit - it's
 * imported as a plain JS module by generate-quote.js.
 *
 * Why this replaces the old Odin-based pricing:
 *   odin.alpy.com is behind a firewall that blocks Vercel's cloud IPs, so any
 *   call to it from these functions always failed silently (pricingAvailable
 *   stayed false). core.alpy.com is the domain alpy.com's own frontend uses
 *   to price the cart - it has no such restriction and is public/no-auth.
 */

const CORE_BASE = 'https://core.alpy.com';

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
              if (promoCode) body.promoCodes = { '1': { code: promoCode } };

        const res = await fetch(CORE_BASE + '/core/cart/dynamic-price-info', {
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

        const discountCents = data && data.discountAbsolute && data.discountAbsolute.amount;
              const discountEur = typeof discountCents === 'number' ? discountCents / 100 : null;
              const shopPriceEur = discountEur != null ? Math.round((totalEur + discountEur) * 100) / 100 : null;

        return {
                  cheapestTotalPrice: totalEur,
                  shopPrice: shopPriceEur,
                  discountAmount: discountEur,
                  pricePerPerson: persons.length > 0 ? Math.round((totalEur / persons.length) * 100) / 100 : totalEur,
                  currency,
                  rentalDays,
                  shopName: shop.name,
                  discountPercentage: data.discountPercentage || null,
        };
      } catch {
              return null;
      }
}

export function countryToCode(country) {
      const map = { france: 'FR', austria: 'AT', switzerland: 'CH', italy: 'IT', germany: 'DE', spain: 'ES', andorra: 'AD' };
      return map[String(country).toLowerCase()] || 'FR';
}
