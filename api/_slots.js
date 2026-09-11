/**
 * Slots and routes — the single declaration of "what a capability needs before
 * it can run", and "what we ask when it is missing".
 *
 * Two tables, deliberately small.
 *
 * SLOTS is keyed by the piece of information, not by the topic: a booking
 * reference is asked for the same way whether the customer wants to cancel or
 * to move their dates. Four slots serve every capability we have.
 *
 * ROUTES declares, per capability, which slots must be present. "a|b" means
 * either one satisfies the requirement — a switch/storage question needs a shop
 * OR a resort, not both.
 *
 * WHY THIS EXISTS. A flow that starts without the information it needs does not
 * fail cleanly: it improvises. On ticket 581628 a date-change flow with no
 * booking reference asked the customer, publicly, to resend their own message.
 * On 581663 the same path answered a job application. Declaring the
 * requirements here, in code, is what turns "the model will figure it out" into
 * "the flow does not start".
 *
 * WHAT THIS IS NOT. It is not a catalogue of every subject a customer can
 * raise. The topics below are the ones we can finish; everything else is OTHER
 * and goes to a human. A classifier with fifty labels, forty of which route to
 * a person, is fifty chances to be wrong for no gain.
 */

export const SLOTS = {
      booking_ref: {
              label: 'booking reference',
              ask: 'Could you send us your booking reference? It is a short code such as B1AF9J, in your confirmation email.',
              // Odin references are 6 uppercase alphanumerics in practice, but we
              // accept 4-12 so a customer who mistypes still gets past the gate
              // and is corrected by the booking lookup rather than by us.
              looksValid: v => /^[A-Z0-9]{4,12}$/.test(String(v || '').trim().toUpperCase()),
      },
      resort_name: {
              label: 'resort',
              ask: 'Which resort will you be skiing in?',
              looksValid: v => String(v || '').trim().length >= 3,
      },
      shop_name: {
              label: 'shop',
              ask: 'Which shop are you asking about?',
              looksValid: v => String(v || '').trim().length >= 3,
      },
      start_date: {
              label: 'first day of the rental',
              ask: 'Which day would you like to pick the equipment up?',
              looksValid: v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()),
      },
      end_date: {
              label: 'last day of the rental',
              ask: 'And which day will you return it?',
              looksValid: v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '').trim()),
      },
      // The headcount, and the second slot to stop holding a price hostage.
      //
      // Measured on 1809 real quote requests: 176 of them state the resort and
      // the dates and never say how many people are coming - against 99 that
      // state all three. Asking those 176 "how many adults?" and sending
      // nothing else is the worst trade we make: a price per person needs only
      // the resort and the dates, it is the number the customer actually wants
      // to know, and the headcount then arrives with their reply instead of
      // instead of it. Agents know this - 45% of the replies that work carry a
      // figure.
      //
      // So one adult is quoted, said out loud as a per-person rate, and the
      // basket is built when they answer. As with the level, this applies only
      // when the resort and the dates are already known; a missing resort means
      // no price is possible at all and the headcount is asked with the rest.
      adults: {
              label: 'number of adults',
              ask: 'How many adults is the equipment for?',
              looksValid: v => Number.isFinite(parseInt(v, 10)) && parseInt(v, 10) >= 0,
              fallback: {
                        value: '1',
                        announce: 'one adult',
                        closing: 'The figure above is therefore the price for one person: ' +
                                 'tell us how many of you are coming and we will build the full basket.',
              },
      },
      // Children are priced on their exact age, so an age we invent is a wrong
      // price discovered at the till. That is why this slot exists, and why for
      // a long time it was required.
      //
      // WHAT CHANGED (582304). Requiring it turned every silent mail into a
      // question. Emma wrote "I would be renting just for me and my husband",
      // gave the resort, the dates and both levels - and got no quote, because
      // she had not written the sentence "there are no children". She had said
      // it: "just for me and my husband" says it exactly. Hundreds of mails
      // arrive in that shape, and holding all of them for a question about
      // children who do not exist is the single largest source of unanswered
      // quotes we have measured.
      //
      // So the slot moves to `assumes` with a fallback of "none", and the
      // assumption is printed in the reply where one word corrects it. The
      // safety it used to provide is kept, and made sharper, by the extractor:
      // a message that MENTIONS a child without giving an age puts the slot
      // straight back into `needs` (see childrenNeedAsking in intent.js), so
      // the only case that is ever assumed is the case where nobody has
      // mentioned a child at all.
      //
      // Silence about children now means no children. Mentioning one and
      // withholding the age still stops the quote, exactly as before.
      children_ages: {
              label: 'age of each child',
              ask: 'How old is each child skiing with you? We need every age — a child is priced on their age, so a quote without them would be wrong. If there are no children, just say so.',
              looksValid: v => {
                        const s = String(v == null ? '' : v).trim();
                        if (s === '' ) return false;
                        if (/^(none|no|no children|aucun|0)$/i.test(s)) return true;   // explicit "no children"
                        const ages = s.split(/[^0-9]+/).filter(x => x !== '').map(Number);
                        return ages.length > 0 && ages.every(a => a >= 0 && a < 100);
              },
              fallback: { value: 'none', announce: 'no children in the group' },
      },
      // The level is the single commonest reason a real quote request never
      // gets a price.
      //
      // Measured on 1809 quote-tagged mails from the last two seasons: 84% of
      // customers never state a level, and it blocks 519 of them. That is not a
      // reading failure - the words are simply not in the mail - so no amount of
      // extraction work will ever recover them. The requirement itself was the
      // problem.
      //
      // Benjamin's decision (Sep 2026): quote the mid range by default and say
      // so, because the quote is a starting point the customer edits - they can
      // change any item, add one, remove one - not a final invoice. But the
      // default applies ONLY when the level is the last thing missing. If the
      // resort or the dates are missing too we are writing to the customer
      // anyway, and the level costs nothing to add to that question.
      //
      // The conditional half lives in intent.js, which is the only place that
      // knows what else is missing; here the slot simply declares both faces.
      equipment_level: {
              label: 'skis or snowboard and the level, person by person',
              ask: 'For each person separately, would they like skis or a snowboard, and are they a beginner, intermediate or expert? A group rarely rents the same tier throughout, and the tier is what sets the price.',
              looksValid: v => String(v || '').trim().length >= 3,
              fallback: {
                        value: 'intermediate',
                        announce: 'mid-range (4-star) equipment at intermediate level for everyone',
              },
      },
      // The three accessories below are asked for one reason: they are priced,
      // and until v5 the quote silently assumed boots-and-helmets-for-everyone
      // and no protection at all. The customer then opened the basket and found
      // a different total. Asking is cheaper than explaining afterwards.
      //
      // "Nobody" is a complete answer for all three. What is not acceptable is
      // silence, because silence used to mean "charge for it anyway".
      //
      // Each carries a `fallback`: the value we take when the customer has not
      // said, and the sentence we print so they know we took it. See the QUOTE
      // route below for why these are assumed rather than asked.
      boots: {
              label: 'who needs boots',
              ask: 'Does everyone need boots as well, or is anyone bringing their own? Tell us who — boots are charged per person.',
              looksValid: v => ACCESSORY_ANSWER(v),
              fallback: { value: 'everyone', announce: 'boots for everyone' },
      },
      helmets: {
              label: 'who needs a helmet',
              ask: 'Would you like helmets, and for whom? They are charged per person, and nobody is obliged to take one.',
              looksValid: v => ACCESSORY_ANSWER(v),
              fallback: { value: 'nobody', announce: 'no helmets' },
      },
      insurance: {
              label: 'damage & theft protection',
              ask: 'Would you like damage & theft protection? It costs 15% of the rental price and covers breakage and theft of the equipment. Yes or no is enough.',
              looksValid: v => ACCESSORY_ANSWER(v),
              fallback: { value: 'no', announce: 'no damage & theft protection' },
      },
};

/**
 * An accessory answer is valid when it says something - "everyone", "nobody",
 * "just the two adults", "yes", "non". It is invalid only when empty.
 *
 * Deliberately lenient. A strict validator on a free-text answer would leave
 * the flow blocked forever on a customer who did answer, just not in the shape
 * we expected; the model downstream reads the sentence anyway.
 */
function ACCESSORY_ANSWER(v) {
      const s = String(v == null ? '' : v).trim();
      if (s === '') return false;
      if (/^(none|no|nobody|no one|non|aucun|personne|0)$/i.test(s)) return true;   // explicit "nobody"
      return s.length >= 2;
}

/**
 * needs: slots that must be satisfied before the capability may run.
 * flow:  the action flow that owns the topic, for the record.
 */
export const ROUTES = {
      DEPOT_SWITCH: {
              flow: 'Shop services (switch & depot)',
              needs: ['shop_name|resort_name'],
      },
      CANCELLATION: {
              flow: 'Cancellation Handler',
              needs: ['booking_ref'],
      },
      DATE_CHANGE: {
              flow: 'Date Change',
              needs: ['booking_ref', 'start_date', 'end_date'],
      },
      // The paid extras are gates again - asked once, and only once.
      //
      // They were removed from this list after 581739, and the reasoning was
      // sound but the diagnosis was not. What actually broke 581739 was never
      // that insurance was required: the customer wrote "No one needs insurance
      // as we have our own insurance also", the extractor failed to record that
      // negation, insurance read as missing, and the repeat-ask guard escalated
      // over a sentence that answered the question outright. The gate was
      // blamed for an extraction bug.
      //
      // Both halves of that are now fixed. The gatekeeper's extractor names all
      // three extras, hasSlot() in intent.js counts an explicit refusal as an
      // answer, and - the part that makes gating safe - a second pass with the
      // extras still unstated declines them and quotes anyway rather than
      // escalating (see declineUnstatedExtras in intent.js).
      //
      // So the customer is asked before the price is built, which is what they
      // are owed: AlpinGuaranty is 15% of the rental, and on a group of fifteen
      // that is not a detail to discover in the basket. Asked once. Silence the
      // second time means no, and the quote goes out.
      //
      // WHAT CHANGED, AND WHY (581658 and the whole family of tickets like it).
      //
      // The three extras above are priced, but none of them stops us from
      // computing a price: every one has an answer we can take by default and
      // say out loud. Requiring them meant a customer who told us the resort,
      // the dates, the group and the level - everything that actually sets the
      // price - still got a question instead of a quote. That is the slow,
      // robotic exchange people complain about, and it is what earned us the
      // bad rating on 581658.
      //
      // So they move from `needs` to `assumes`. The quote is built on a stated
      // assumption and the assumption is printed in the reply, where the
      // customer can correct it in one word. Boots yes, because someone renting
      // skis nearly always needs them and leaving them out understates the
      // price; helmets and protection no, because charging for something nobody
      // asked for is the worse error of the two.
      //
      // A stated assumption the customer can refuse is honest. A question that
      // holds the whole quote hostage is not helpfulness, it is a queue.
      QUOTE: {
              flow: 'Quote Generator',
      // WHAT A QUOTE REALLY REQUIRES: a place and a period. Nothing else.
      //
      // Everything below `needs` is something we can take a stated default for
      // and print in the reply, where one word corrects it. A place and a
      // period are different in kind: without them there is no price to
      // compute at all, not even a wrong one.
      //
      // Drawing the line there is what turns 99 answerable mails into 275 on
      // the same corpus. The other five slots are not unimportant - they are
      // simply not worth a round trip that a third of customers never complete.
              needs: ['resort_name|shop_name', 'start_date', 'end_date'],
              assumes: ['adults', 'children_ages', 'equipment_level', 'boots', 'helmets', 'insurance'],
      },
      REQUOTE: {
              flow: 'Requote from booking',
              needs: ['booking_ref'],
      },
      VOUCHER_RESEND: {
              flow: 'Voucher Resend',
              needs: ['booking_ref'],
      },
      PARTIAL_CANCELLATION: {
              flow: 'Partial cancellation',
              needs: ['booking_ref'],
      },
      // The rental has already started: injury, illness, an early return.
      //
      // There is no automatic outcome here and there must not be one. The fee is
      // 100%, a goodwill gesture is discretionary, and it depends on two
      // documents a customer almost never sends unprompted - a medical
      // certificate dated inside the rental period, and the shop's written
      // confirmation of the early return. So the flow's whole job is to ask for
      // those two documents, say what happens next, and put the booking facts in
      // front of an agent. It never touches the booking and never creates a
      // coupon.
      //
      // needs is deliberately empty, and it used to be ['booking_ref'].
      //
      // Everything the answer depends on - the dates, whether Alpinsafety Plus is
      // on the booking, whether they bought the cancellation cover - is only
      // knowable from the booking, so the reference genuinely is required. But
      // requiring it HERE meant asking the customer for it, and the flow can now
      // find it on its own: it reads the requester's address, searches Odin on
      // that address, and takes the most recent booking whose rental has already
      // started. Gating on the slot therefore bought nothing and cost a round
      // trip - the worst possible one, since it lands on someone who has just
      // written to us injured.
      //
      // The flow still refuses to answer blind: if neither the message nor the
      // email address yields a booking, it hands over with a note saying so.
      // That check belongs there, where the booking is actually read, not here.
      CANCELLATION_AFTER: {
              flow: 'Cancellation after start',
              needs: [],
      },
      // Questions that need knowledge and no action at all.
      //
      // "Can I have an invoice?" "Are poles included?" "Do you take AMEX?" "Is a
      // helmet compulsory in Italy?" - none of these touch a booking, and every
      // one of them has a settled answer written down. They are a large part of
      // the 21% of tickets that carry no topic tag, and today every one of them
      // costs an agent a full reply.
      //
      // needs is deliberately empty. There is nothing to collect: the question
      // is the whole request, so this route is ready on the first comment and
      // never asks the customer anything.
      GENERAL_QUESTION: {
              flow: 'General questions',
              needs: [],
      },
      // A skier's details on an existing booking: height, weight, shoe size,
      // level, date of birth, name (581982). The flow reads the booking, matches
      // the person, writes through Odin and verifies by read-back. needs is
      // empty on purpose: the flow reads the reference from the whole ticket
      // (the subject line included, where customers put it) and asks for it
      // itself when it is genuinely absent - gating here would only cost a
      // round trip when the code is sitting in the subject.
      PERSONAL_INFO: {
              flow: 'Skier details (personal info)',
              needs: [],
      },
      // No slot at all: the flow finds BOTH bookings itself, from the email
      // address that made them. Asking the customer for a reference is exactly
      // the failure this capability was written to remove (582032).
      DUPLICATE_BOOKING: {
              flow: 'Duplicate booking',
              needs: [],
      },
      OTHER: {
              flow: null,
              needs: [],
      },
};

/*
 * The question we send when the core is missing - and why its shape matters
 * more than any of the extraction work around it.
 *
 * Measured on 320 real quote tickets: when an agent replies with the intake
 * macro, the customer answers 63% of the time. More than a third of quote
 * requests die on the question, which is a larger loss than anything the
 * reader can still recover.
 *
 * What we used to send was one sentence with every hole strung through it:
 * "To prepare this we need resort or shop, first day of the rental, last day
 * of the rental, number of adults and skis or snowboard and the level, person
 * by person." Five clauses, no line breaks, read on a phone. The agents' macro
 * puts one item per line and converts.
 *
 * So: short lines, related things merged into one line - a first and last day
 * is one question to a human, not two - and a closing sentence that says a
 * single line back is enough. No warnings, no pricing lecture: those belong in
 * the reply that carries the price, not in the message asking for permission
 * to compute it.
 */
const ASK_LINES = [
      { needs: ['resort_name', 'shop_name'], line: 'the resort (or the shop, if you have one in mind)' },
      { needs: ['start_date', 'end_date'],   line: 'the first and last day of the rental' },
      { needs: ['adults', 'children_ages'],  line: 'how many of you are coming, and the age of any children' },
      { needs: ['equipment_level'],          line: 'skis or a snowboard for each person, and roughly what level' },
      { needs: ['boots', 'helmets', 'insurance'], line: 'who needs boots or a helmet, and whether you want damage & theft protection' },
];

function composeAsk(missing) {
      const flat = new Set();
      for (const req of missing) for (const n of req.split('|')) flat.add(n);

      const lines = ASK_LINES
        .filter(g => g.needs.some(n => flat.has(n)))
        .map(g => '- ' + g.line);

      // A slot nobody thought to group still gets asked, rather than silently
      // dropped: a question that omits what it needs is worse than an ugly one.
      const covered = new Set(ASK_LINES.flatMap(g => g.needs));
      for (const n of flat) if (!covered.has(n) && SLOTS[n]) lines.push('- ' + SLOTS[n].label);

      return 'Could you send us:\n' + lines.join('\n') +
             '\nOne short reply with those and the price follows.';
}

/**
 * Which declared slots are not satisfied, and the single question to ask next.
 *
 * Returns { missing, satisfied, nextQuestion, ready }.
 *
 * One question at a time, in the order the capability declares them. Asking a
 * customer for six things in one message is how you get two of them back.
 */
/**
 * extraNeeds: requirements the CALLER discovered in the message itself, added
 * to the ones the route declares.
 *
 * One caller, one reason. children_ages is assumed to be "none" when nobody
 * mentions a child, but a message that names a child without giving an age has
 * to be asked - and only the extractor, which read the message, knows which of
 * the two happened. Rather than duplicate the route table for that single
 * case, the caller hands the requirement back in.
 *
 * A slot named here is also removed from the assumed list: a requirement and
 * an assumption about the same value would contradict each other, and the
 * requirement is the stricter of the two.
 */
export function checkSlots(topic, slots, extraNeeds) {
      const route = ROUTES[topic] || ROUTES.OTHER;
      const values = slots || {};
      const missing = [];
      const satisfied = [];

      const added = (extraNeeds || []).filter(n => SLOTS[n] && !route.needs.includes(n));
      const needs = route.needs.concat(added);

      for (const requirement of needs) {
              const alternatives = requirement.split('|');
              const met = alternatives.find(name => {
                        const def = SLOTS[name];
                        return def && def.looksValid(values[name]);
              });
              if (met) satisfied.push(met);
              else missing.push(requirement);
      }

      let nextQuestion = null;
      let nextQuestionAll = null;
      if (missing.length) {
              // For an either/or requirement, ask for the first alternative - it is
              // the one the capability prefers.
              const first = missing[0].split('|')[0];
              nextQuestion = SLOTS[first] ? SLOTS[first].ask : null;

              // With several holes, ask for all of them in ONE message.
              //
              // This is not a style choice. A flow has no memory between comments:
              // if we ask one question per turn, the answer to turn 1 is gone by
              // turn 3. A quote needs six things; asked one at a time they would
              // never all be present at once and the flow could never run.
              // Asked together, the customer's single reply carries them all and
              // the accumulation problem disappears instead of being solved.
              if (missing.length === 1) {
                        nextQuestionAll = nextQuestion;
              } else {
                        nextQuestionAll = composeAsk(missing);
              }
      }

      // Assumed slots: never block, always announced.
      //
      // If the customer stated one, we use what they said and there is nothing
      // to announce. If they did not, we take the declared fallback and add it
      // to `assumedSentence`, which the reply must print verbatim so the
      // customer can correct it in one word.
      const assumed = [];
      const values2 = values;
      for (const name of (route.assumes || []).filter(n => !added.includes(n))) {
              const def = SLOTS[name];
              if (!def || !def.fallback) continue;
              if (def.looksValid(values2[name])) continue;
              assumed.push({
                        slot: name, value: def.fallback.value,
                        announce: def.fallback.announce, closing: def.fallback.closing || null,
              });
      }

      /*
       * The assumptions, said plainly, and one thing said separately.
       *
       * Everything we took a default for goes into one list the customer can
       * scan. But a headcount of one is not an assumption of the same kind: it
       * changes what the figure in the mail MEANS - a rate per person rather
       * than a total - and burying that in the middle of a comma list is how a
       * customer reads a price for six people and books a surprise. So a
       * fallback may carry its own closing sentence, which is printed after the
       * list rather than inside it.
       */
      // An assumption only means something next to a price. Printing "we have
      // assumed boots for everyone" in a message that asks which resort they
      // are going to is noise at best, and at worst it reads as though a quote
      // were attached when none is.
      let assumedSentence = null;
      if (assumed.length && !missing.length) {
              const parts = assumed.map(a => a.announce);
              const last = parts.pop();
              const closings = assumed.map(a => a.closing).filter(Boolean);
              assumedSentence = 'We have assumed ' +
                        (parts.length ? parts.join(', ') + ' and ' + last : last) + '. ' +
                        (closings.length ? closings.join(' ') + ' ' : '') +
                        'Nothing here is fixed: the quote is a starting point you can change ' +
                        'item by item — swap a level, add something, take something out — and ' +
                        'we will re-price it. Just tell us what to change.';
      }

      return {
              missing,
              satisfied,
              nextQuestion,
              nextQuestionAll,
              assumed,
              assumedSentence,
              ready: missing.length === 0 && topic !== 'OTHER',
      };
}

export const TOPICS = Object.keys(ROUTES);
