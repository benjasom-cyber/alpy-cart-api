/**
 * POST /api/intent
 *
 * One place that answers two questions for every action flow:
 *   1. what does this customer actually want (a topic we can finish, or OTHER)
 *   2. what do we still need before the flow may run, and what do we ask next
 *
 * ─── WHY THE LLM IS THE LAST LAYER, NOT THE FIRST ───────────────────────────
 *
 * Three layers, in decreasing order of trust:
 *
 *   1. NATIVE ZENDESK INTENT TAGS. Zendesk's own triage already tags tickets,
 *      and on the two incidents that prompted this file it was right both times:
 *      581663 carried intent__misc__job_application__new (high confidence) and
 *      581628 carried intent__sell__update__price. Our flows ignored them and
 *      answered anyway. Free, already computed, and it decides first.
 *
 *   2. ALPY VOCABULARY. "depot", "consigne", "modelchange", "changement
 *      d'equipement" - the business words. A generic taxonomy has no label for
 *      the two services our customers pick a shop on, and a plain keyword hit
 *      needs no model.
 *
 *   3. THE MODEL, only when 1 and 2 are silent. The caller runs the prompt (it
 *      is cheap inside a flow) and passes the result in as llm_topic/llm_slots.
 *      This endpoint decides whether to trust it. Keeping the model outside
 *      means one prompt, versioned in git, testable offline - not eight prompts
 *      scattered across eight flows, each free to drift.
 *
 * ─── THE RULE THAT MUST SURVIVE ─────────────────────────────────────────────
 *
 * The model classifies and extracts. This file decides. A flow never asks the
 * model "what should I do" - it asks this endpoint "may I run, and what is
 * missing". next_question is a SUGGESTION: the flow still has to pass its own
 * gate before it may put a question in front of a customer. That gate is what
 * was missing when a booking-reference request went out publicly on a forwarded
 * internal price list.
 */

import { SLOTS, ROUTES, TOPICS, checkSlots } from './_slots.js';

const CORS = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Native intent tags we trust to decide on their own. Anything not listed is
// not evidence - absence of a tag says nothing.
const TAG_TO_TOPIC = {
      'intent__travel__booking_cancellation__cancel': 'CANCELLATION',
      'intent__travel__booking_cancellation__undo_cancel': 'OTHER',
      'intent__travel__booking_cancellation__policy': 'OTHER',
      'intent__order__new__quote_request': 'QUOTE',
};

// Tags that mean "no customer request here at all". These end the conversation
// before any topic is considered: 411 tickets on this instance carry one.
const NEVER_ANSWER = [
      'intent__misc__unsolicited__partnership',
      'intent__misc__unsolicited__marketing_or_newsletter',
      'intent__misc__unsolicited__spam',
      'intent__misc__unsolicited__event_invitation',
      'intent__misc__job_application__new',
];

// Alpy's own vocabulary. Order matters: the first match wins, so the most
// specific patterns come first.
const KEYWORDS = [
      // THE SAME BOOKING MADE TWICE (582032).
      //
      // "I have accidentally made a duplicate booking when making payment for
      // our ski hire. Could one of these be refunded please?" was read as a
      // refund request, routed to the cancel-after flow, and answered by asking
      // Colin for the second reference - which Odin already held, twice, under
      // his own email. This rule sits FIRST because a duplicate says "refund"
      // and "cancel" out loud and would otherwise be eaten by those rules; the
      // duplicate flow finds both bookings itself and needs no reference.
      //
      // Both halves are required: the idea of doubling AND the idea of a
      // booking or a payment. "I paid twice for the boots" is a billing
      // question, not two bookings, so the second half names the booking.
      // TWICE MUST MEAN TWICE BOOKED, NOT TWICE ASKED (582095).
      //
      // "I have already enquired about this using the chat bot which assured me
      // a ticket had been raised with the support team TWICE but heard nothing"
      // - a customer who paid and never got a confirmation, and the flow that
      // cancels and refunds a duplicate booking started up. Three separate
      // lookaheads, each satisfied by a different sentence: twice (the chatbot),
      // booking reference (the thing he never received), payment (taken). None
      // of them were about each other.
      //
      // So the doubling word and the booking word must now be NEAR each other -
      // 120 characters, either order - and two shapes are excluded outright:
      // a doubling word that counts how often they CONTACTED us, and a message
      // that says a confirmation was NOT received, which is the opposite of
      // holding two of them.
      { topic: 'DUPLICATE_BOOKING',
        re: /^(?![\s\S]*\b(?:twice|two\s+times|2\s+times|deux\s+fois|zweimal|due\s+volte|dos\s+veces)\b[\s\S]{0,70}\b(?:ticket\w*|chat\w*|bot|e-?mail\w*|contact\w*|call\w*|phon\w*|rais\w*|ask\w*|enquir\w*|wrote|writ\w*|messag\w*|reminder\w*|relanc\w*|appel\w*|[eé]crit|demand\w*|support\s+team)\b)(?![\s\S]*\b(?:ticket\w*|chat\w*|bot|e-?mail\w*|contact\w*|call\w*|phon\w*|rais\w*|ask\w*|enquir\w*|wrote|writ\w*|messag\w*|reminder\w*|relanc\w*|appel\w*|[eé]crit|demand\w*)\b[\s\S]{0,40}\b(?:twice|two\s+times|2\s+times|deux\s+fois|zweimal|due\s+volte|dos\s+veces)\b)(?![\s\S]*\b(?:not|never|no|n.ai\s+pas|jamais|nicht|kein\w*|aucun\w*)\b[\s\S]{0,50}\b(?:received|receiv\w*|re[cç]u\w*|erhalten|got|bekommen)\b[\s\S]{0,80}\b(?:confirmation|booking\s+reference|voucher|buchungsnummer|num[eé]ro\s+de\s+r[eé]servation)\b)(?=[\s\S]*(?:\b(?:duplicate|duplicated|duplicat\w*|doubl\w*|twice|two\s+times|2\s+times|deux\s+fois|en\s+double|doppelt|zweimal|due\s+volte|dos\s+veces|same\s+booking\s+again|by\s+mistake|par\s+erreur|aus\s+versehen|versehentlich|accidentally|accidentellement)\b[\s\S]{0,120}\b(?:booking|bookings|reservation|reservations|r[eé]servations?|buchung\w*|prenotazion\w*|reservas?|order|commande|bestellung)\b|\b(?:booking|bookings|reservation|reservations|r[eé]servations?|buchung\w*|prenotazion\w*|reservas?|order|commande|bestellung)\b[\s\S]{0,120}\b(?:duplicate|duplicated|duplicat\w*|doubl\w*|twice|two\s+times|2\s+times|deux\s+fois|en\s+double|doppelt|zweimal|due\s+volte|dos\s+veces|same\s+booking\s+again|by\s+mistake|par\s+erreur|aus\s+versehen|versehentlich|accidentally|accidentellement)\b))(?=[\s\S]*\b(?:refund\w*|rembours\w*|erstatt\w*|r[uü]ckerstatt\w*|rimbors\w*|reembols\w*|cancel\w*|annul\w*|stornier\w*|charged|d[eé]bit[eé]\w*|abgebucht|paid|pay[eé]\w*|payment|paiement|zahlung)\b)/i },
      // A DOUBLE BOOKING, SAID IN DUTCH, SPANISH OR ITALIAN (11 septembre 2026).
      // "dubbel geboekt", "dos veces por error", "due volte" - none of the three
      // was in the rule above, and the Dutch one was routed as a plain
      // cancellation, which would have cancelled the wrong thing.
      { topic: 'DUPLICATE_BOOKING',
        re: /(?=[\s\S]*\b(?:dubbel\w*|twee\s+identieke|dos\s+veces|duplicad\w*|due\s+volte|doppia\s+prenotazione)\b)(?=[\s\S]*\b(?:annul\w*|anul\w*|cancel\w*|storn\w*|rimbors\w*|reembols\w*|terugbetal\w*)\b)/i },

      // STOLEN OR DAMAGED EQUIPMENT IS A CLAIM, NOT A LOCKER QUESTION.
      //
      // 581954: "the ski boots I rented at Le Bourg were stolen from our hotel
      // locker. I purchased the Alpinguaranty protection. What do I need to do
      // to file a claim?" The word "locker" matched the depot rule below and the
      // customer was routed to the shop-services flow, which talks about
      // overnight storage. Every other word of that message is an insurance
      // claim. This rule sits first so that a theft or damage word next to an
      // equipment or protection word decides before "locker" is even read.
      // It routes to GENERAL_QUESTION, whose knowledge base holds the
      // protections and knows to hand a claim over rather than improvise.
      { topic: 'GENERAL_QUESTION',
        re: /(?=[\s\S]*\b(?:stolen|theft|thie(?:f|ves)|robbed|vol[eé]e?s?\b|d[eé]rob[eé]\w*|gestohlen|diebstahl|entwendet|rubat[oi]|furto|robad[oa]s?|robo\b|damaged|broken\s+(?:ski|boot|board|helmet|binding|pole)|snapped|cass[eé]e?s?\b|endommag[eé]\w*|besch[aä]digt|kaputt|danneggiat\w*|da[nñ]ad[oa]s?|rot[oa]s?\b|sinistre|claim\b|r[eé]clamation|schaden(?:s?fall|meldung)?))(?=[\s\S]*\b(?:skis?|boots?|snowboard|board|helmet|casque|chaussures?|mat[eé]riel|equipment|Ski|Schuhe|Helm|Brett|attrezzatura|scarponi|equipo|botas|guaranty|guarantee|protection|assurance|insurance|versicherung|assicurazione|seguro|garantie))/i },
      // A PROSPECT WHO ALSO MENTIONS THE DEPOT IS STILL A PROSPECT (582033).
      //
      // "Wir sind 5 Erwachsene, 6 Skitage in Solden, wir moechten die komplette
      // Skiausruestung ausleihen ... ausserdem gerne Ihr Depot an der
      // Gaislachkoglbahn ... Koennten Sie uns bitte ein Gesamtangebot fuer 5
      // Personen zukommen lassen?" - one word, "Depot", sent the whole thing to
      // the shop-services flow. The customer got a paragraph about overnight
      // storage, the promise of an offer, and no offer. Five pairs of skis for
      // six days, lost.
      //
      // A quote is the commercial answer and it comes first: when someone asks
      // for an offer or a price AND talks about renting equipment, this is a
      // QUOTE, whatever else the message mentions. The depot, the group discount
      // and the early-booking question are answered inside the quote reply.
      //
      // Excluded: anyone who already has a booking (a reference, "my booking",
      // "meine Buchung") - for them the depot question is a real depot request.
      { topic: 'QUOTE',
        re: /^(?![\s\S]*(?:\b[Bb][0-9A-Za-z]{5}\b[\s\S]{0,40}\b(?:booking|buchung|r[eé]servation|prenotazione|reserva)\b|\b(?:my|our|meine?|unsere?|ma|notre|mon)\s+(?:booking|buchung|r[eé]servation|reservierung|prenotazione|reserva)\b|\bbooking\s+(?:reference|number|code)\b|\bbuchungsnummer\b|\bnum[eé]ro\s+de\s+r[eé]servation\b))(?=[\s\S]*\b(?:angebot|gesamtangebot|offerte|offer\b|quote|quotation|devis|price|prices|preis\w*|prix|prezzo|precio|kost\w*|tarif\w*|how\s+much|wie\s+viel|combien|rate\b|rates\b|gruppenrabatt|group\s+discount|rabatt|discount|r[eé]duction|fr[uü]hbuch\w*|early\s*[- ]?book\w*)\b)(?=[\s\S]*(?:\b\d{1,3}\s*(?:erwachsene\w*|adults?|personen|persons?|people|pax|personnes|adultes|skifahrer|skiers?|kinder|children)\b|\b(?:group|groupe|gruppe|gruppo|grupo|family|famille|familie)\b|\b\d{1,2}\s*(?:skitage|days?|tage|jours?|giorni|d[ií]as)\b|\b(?:from|vom|du|dal|desde)\s+\d{1,2}\b|\b\d{1,2}[./]\d{1,2}\b|\b(?:angebot|gesamtangebot|offerte|offer|quote|quotation|devis|offre)\b))(?=[\s\S]*\b(?:ausleihen|leihen|mieten|verleih|ausr[uü]stung|rent|renting|rental|hire|hiring|louer|location|noleggi\w*|alquil\w*|skiausr[uü]stung|skis?\b|ski\b|snowboards?|equipment|mat[eé]riel|attrezzatura|equipo)\b)/i },

      // A DOWNGRADE IS A PARTIAL CANCELLATION, NOT A QUOTE AND NOT A MODEL CHANGE.
      //
      // 582070: "Please change the Diamond skis Lady skis to Red skis Lady...
      // could you refund the difference which is 27.30". Nothing matched except
      // the QUOTE rule, so the customer got the new-quote questionnaire - dates,
      // adults, ages of the children - for a booking she had made the day
      // before, plus a sentence saying we cannot change bookings here. Both
      // halves were wrong.
      //
      // Odin cannot swap one line for a cheaper one: the right answer is to
      // cancel THAT item, refund it, and let the customer re-book the cheaper
      // range at the current price. That is a partial cancellation, so the
      // rule routes there and the flow explains the re-booking.
      //
      // Three conditions together, because any one of them alone is a different
      // request: an EXISTING BOOKING marker, a CHANGE verb, and a RANGE or a
      // difference-of-price word. "Can I switch skis mid-week" has none of the
      // three and stays with the model-change rule below; "change my dates" is
      // excluded outright.
      { topic: 'PARTIAL_CANCELLATION',
        re: /^(?![\s\S]*\b(?:dates?|date\s+change|p[eé]riode|zeitraum|termin)\b)(?=[\s\S]*(?:\bB[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}\b|\b(?:my|our|the|ma|mes|notre|nos|la|meine?|unsere?)\s+(?:booking|reservation|r[eé]servation|order|buchung|prenotazione|reserva)\b|\bi\s+(?:have\s+)?booked\b|\bj.ai\s+r[eé]serv[eé]\b|\bich\s+habe\s+gebucht\b))(?=[\s\S]*\b(?:change|changed|changing|swap|swapping|replace|replacing|downgrade|downgrading|switch|switching|changer|remplacer|passer|basculer|r[eé]trograder|(?:ae|[aä])ndern|wechseln|tauschen|umbuchen|umstellen|cambiare|sostituire|cambiar)\b)(?=[\s\S]*(?:\b(?:diamond|diamant|platin\w*|black|gold|silver|silber|red|rouge|rot|blue|bleu|blau|green|vert|rookie|champion|vip|top)\b[\s\S]{0,80}\b(?:ski\w*|snowboard\w*|board\w*|mat[eé]riel|ausr[uü]stung)\b|\b(?:ski\w*|snowboard\w*|board\w*|mat[eé]riel|ausr[uü]stung)\b[\s\S]{0,80}\b(?:diamond|diamant|platin\w*|black|gold|silver|silber|red|rouge|rot|blue|bleu|blau|green|vert|rookie|champion|vip|top)\b|\b(?:gamme|cat[eé]gorie|category|categoria|range|price\s+range|preisklasse|kategorie|quality\s+category|\d\s*\*|\d\s*star\w*|\d\s*[eé]toiles?|\d\s*sterne?)\b|\b(?:refund|rembours\w*|erstatt\w*|rimbors\w*|reembols\w*)\w*\s+(?:me\s+)?(?:the\s+|la\s+|die\s+|il\s+)?(?:difference|diff[eé]rence|differenz|differenza|diferencia)\b|\b(?:difference|diff[eé]rence|differenz|differenza|diferencia)\s+(?:in\s+|de\s+|of\s+|du\s+)?(?:price|prix|preis|prezzo|precio|cost|co[uû]t)\b))/i },

      // The depot rule must never fire on a theft that merely happened in a
      // locker: the rule above already took those.
      { topic: 'DEPOT_SWITCH', re: /^(?![\s\S]*\b(?:stolen|theft|thie(?:f|ves)|vol[eé]e?s?\b|gestohlen|diebstahl|damaged|cass[eé]e?s?\b|besch[aä]digt|claim\b|sinistre)\b)[\s\S]*\b(d[eé]p[oô]t|consigne|casier|bagagerie|overnight storage|locker|ski\s?room|local\s+[aà]\s+skis|garde\s+du\s+mat[eé]riel|store\s+(?:our|my|the)\s+(?:skis|equipment|gear)|leave\s+(?:our|my|the)\s+(?:skis|equipment|gear)|laisser\s+(?:les|mes|le|mon|notre|nos)\s+(?:skis|mat[eé]riel|[eé]quipement|affaires))\b/i },
      // "change the model of skis" is a model change too. The rule used to
      // require the two words welded together ("model change") or "switch my
      // skis", so a customer writing the sentence the natural way matched
      // nothing at all.
      // ... but only about a booking that exists.
      //
      // "Changement de l'équipement" is also the name of a PAID OPTION on the
      // website, and a customer requesting a quote lists it beside boots and
      // insurance: on 582304 Emma wrote "Ski's, boots, with change model and
      // insurance" and this rule claimed her, sending a brand-new quote request
      // to the flow that swaps equipment on an existing rental. She had no
      // booking to swap anything on.
      //
      // So the rule now requires a booking to be in the room - a reference, or
      // the customer's own words about their booking. Wanting the option is a
      // quote; wanting a different pair of skis is a model change.
      { topic: 'DEPOT_SWITCH', re: /^(?=[\s\S]*(?:\bB[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}\b|\b(?:my|our|the|this|mein\w*|unser\w*|dies\w*|ihr\w*|ma|mon|mes|notre|nos|cette|mijn|onze|deze|mia|mio|nostra|nostro|questa|questo|mi|mis|nuestr\w*|est[ae])\s+(?:booking|reservation|r[eé]servation|buchung|reservierung|boeking|reservering|prenotazione|reserva|order|commande|bestellung|bestelling|ordine|pedido)\b|\bbooking\s+(?:number|reference|ref|code)\b|\bbereits\s+gebucht\b|\bd[eé]j[aà]\s+r[eé]serv[eé]))[\s\S]*\b(modelchange|model\s+change|change\s+(?:the\s+|my\s+)?model|changement\s+d.?[eé]quipement|changer\s+(?:le\s+)?mod[eè]le|modell\s*(?:wechsel|tausch)|modell\s+(?:zu\s+)?[aä]ndern|switch\s+(my|the|from)?\s?(skis?|snowboard)|[eé]changer\s+(les|mes)\s+skis|swap\s+(my|the)\s+(skis?|snowboard)|changer\s+de\s+(?:skis?|mat[eé]riel|[eé]quipement|snowboard|planche)|change\s+(?:our|my|the)\s+(?:skis|equipment|gear)|mod[eè]le\s+ne\s+(?:nous\s+|me\s+)?convient\s+pas)\b/i },
      { topic: 'VOUCHER_RESEND', re: /\b(voucher|bon\s+de\s+r[eé]servation|renvoyer\s+le\s+voucher|resend\s+(the\s+)?voucher|confirmation\s+email\s+again)\b/i },
      // THE DOCUMENTS OF A PROTECTION ARE VOUCHERS TOO (581968).
      //
      // "Wie komme ich an die Unterlagen zur gebuchten Versicherung?" went to
      // General questions, which explained the protection and handed over. The
      // customer wanted the PDF. The Voucher Resend flow now answers with the
      // direct links to every document of the booking (rental voucher, the
      // protection certificates, the payment confirmation) read from Odin, so a
      // document word next to a protection or payment word routes there.
      { topic: 'VOUCHER_RESEND',
        re: /(?=[\s\S]*\b(?:documents?|unterlagen|dokumente?|paperwork|attestations?|certificat\w*|zertifikat\w*|bescheinigung\w*|versicherungsschein\w*|nachweis\w*|justificatifs?|policy|police\s+d.assurance|contrat|contract|vertrag|copie|copy|pdf|re[cç]u|receipt|quittung|rechnung|facture|invoice|confirmation\s+de\s+paiement|payment\s+confirmation|zahlungsbest[aä]tigung|ricevuta|recibo|documentos?|documenti))(?=[\s\S]*\b(?:protections?|assurances?|insurances?|versicherung\w*|assicurazion\w*|seguros?|guaranty|garantie|flexi|safety|paiement|payment|zahlung|pagamento|pago))/i },
      // "MY PAYMENT FAILED - PLEASE RESEND THE PAYMENT LINK" (582031).
      //
      // Jon's Google Pay attempt was declined at 14:02, his card went through at
      // 14:03, and at 14:06 he asked us for a new payment link on a booking that
      // was already paid. Nothing matched: "No capability matches this message",
      // and a customer who believed he had no booking waited for a human on a
      // question Odin answers in one read. Voucher Resend is that read - it now
      // states the payment status and sends the payment confirmation, and hands
      // over when the booking really is unpaid.
      //
      // Excluded: refunds and cancellations (a payment that must come BACK is
      // another route entirely), and the "I do not understand the amount" case,
      // which the rule further down already owns.
      { topic: 'VOUCHER_RESEND',
        re: /^(?![\s\S]*\b(?:refund\w*|reimburs\w*|rembours\w*|erstatt\w*|r[uü]ckerstatt\w*|rimbors\w*|reembols\w*|money\s+back|cancel\w*|annul\w*|stornier\w*|chargeback)\b)(?=[\s\S]*\b(?:payment|paiement|zahlung|pagamento|pago|paid|pay|payer|zahlen|pagare|pagar|card|carte|karte|kreditkarte|checkout|google\s*pay|apple\s*pay|paypal)\b)(?=[\s\S]*(?:\b(?:fail\w*|declin\w*|refus[eé]\w*|rejet[eé]\w*|d[eé]clin\w*|fehlgeschlagen|abgelehnt|gescheitert|rifiutat\w*|fallit\w*|rechazad\w*|fallid\w*|unsuccessful|not\s+work\w*|did\s*n.?t\s+work)\b|\b(?:did\s*n.?t|does\s*n.?t|not)\s+go(?:ne)?\s+through\b|\bnot\s+been\s+taken\b|\bpayment\s+(?:link|page)\b|\blien\s+de\s+paiement\b|\bzahlungslink\b|\blink\s+di\s+pagamento\b|\benlace\s+de\s+pago\b|\b(?:resend|re-?send|send)\s+(?:me\s+)?(?:a\s+|the\s+|another\s+|new\s+)*(?:payment|paiement)\b|\brenvoyer[\s\S]{0,25}(?:paiement|lien)\b|\bpay\s+again\b|\bpayer\s+[aà]\s+nouveau\b|\bnochmal\s+(?:be)?zahlen\b))/i },

      // The rental has started and something went wrong with the person, not
      // with the booking. This sits ABOVE CANCELLATION on purpose: "I want to
      // cancel, I broke my leg" is not a cancellation we can process, it is a
      // 100% case that needs two documents and a human decision, and routing it
      // to the cancellation handler would offer the customer a fee table that
      // does not apply to them.
      //
      // Both halves are required. An injury word alone matches "what does
      // Alpinsafety cover in case of an accident?", which is a pre-booking
      // question and must not land here; a cancel or refund word alone is an
      // ordinary cancellation. Only the two together mean what this route means.
      { topic: 'CANCELLATION_AFTER',
        re: /(?=[\s\S]*\b(injur\w*|blessur\w*|bless[ée]\w*|accident\w*|malad\w*|sick|illness|ill\b|krank\w*|verletz\w*|unfall\w*|broke\s+(?:my|his|her)\s+\w+|cass[ée]\s+(?:ma|mon|sa)\s+\w+|medical\s+certificate|certificat\s+m[eé]dical|arztlich\w*))(?=[\s\S]*\b(cancel\w*|annul\w*|refund\w*|rembours\w*|storno\w*|stornier\w*|r[uü]ckerstattung\w*|remaining\s+days?|jours?\s+restants?|returned?\s+(?:it\s+|them\s+|the\s+equipment\s+)?early|rendu\s+(?:le\s+)?mat[eé]riel|rentr[ée]s?\s+plus\s+t[oô]t|unused\s+days?|jours?\s+(?:non\s+)?utilis[eé]s?))/i },
      // AN EARLY RETURN IS A CANCEL-AFTER, EVEN WITHOUT AN INJURY.
      //
      // 581919: "the Ski Republic store in Chamonix told us we would be
      // reimbursed for the unused days since we returned the equipment 3 days
      // before the end of the rental period. It has been 4 weeks." Every word of
      // that is a cancel-after - the rental had started, the equipment came back
      // early, money is owed - and it matched NOTHING, because the rule above
      // demands an injury word. The customer got "No capability matches this
      // message" on a request that names its booking and its amount of days.
      //
      // Illness is the common cause of an early return, not the only one. This
      // rule pairs the two halves that actually define the case: a refund asked
      // for, and days that were paid but not used.
      { topic: 'CANCELLATION_AFTER',
        re: /(?=[\s\S]*\b(?:refund\w*|reimburs\w*|rembours\w*|erstatt\w*|r[uü]ckerstatt\w*|money\s+back|rimbors\w*|reembols\w*))(?=[\s\S]*(?:\bunused\s+days?\b|\bdays?\s+(?:we|they|i)\s+(?:did\s+not|didn.t|could\s+not|couldn.t|never)\s+use\b|\bjours?\s+(?:non\s+)?utilis[eé]s?\b|\bnicht\s+genutzte\w*\s+tage\b|\breturn\w*[\s\S]{0,40}(?:early|earlier|\d+\s+days?\s+(?:before|early))\b|\brendu[\s\S]{0,30}(?:mat[eé]riel|skis?|plus\s+t[oô]t)\b|\brentr[eé]\w*\s+plus\s+t[oô]t\b|\b(?:vorzeitig|fr[uü]her)\s+zur[uü]ck\w*|\bremaining\s+days?\b|\bjours?\s+restants?\b))/i },
      // THE SAME CASE, IN DUTCH, ITALIAN AND SPANISH (11 septembre 2026).
      //
      // The two rules above are built from English, French and German words.
      // "Ik heb mijn been gebroken ... krijg ik de niet gebruikte dagen terug?",
      // "ho restituito gli sci in anticipo, posso avere un rimborso dei giorni
      // non utilizzati" and "devolvi los esquis antes ... reembolso de los dias
      // no utilizados" all fell through - three ways of describing the one case
      // that must never be priced like an ordinary cancellation.
      { topic: 'CANCELLATION_AFTER',
        re: /(?=[\s\S]*(?:gebroken|blessure|gewond|ziek\b|rotto|rotta|infortun\w*|malatt\w*|malato|roto|rota|lesi[oó]n\w*|enferm\w*|herido|niet\s+gebruikte\s+dagen|eerder\s+terug\w*|giorni\s+non\s+utilizzat\w*|restituit\w*\s+in\s+anticipo|d[ií]as\s+no\s+utilizad\w*|devolv[ií]\w*\s+antes))(?=[\s\S]*(?:terugbetal\w*|terug\s+krijg\w*|vergoeding|rimbors\w*|reembols\w*|devoluci[oó]n|niet\s+gebruikte\s+dagen|giorni\s+non\s+utilizzat\w*|d[ií]as\s+no\s+utilizad\w*))/i },
      // "I DO NOT UNDERSTAND THE AMOUNT CHARGED" IS A VOUCHER QUESTION.
      //
      // Customers open the rental voucher, see one figure, compare it to the card
      // debit and write to us. The difference is always on the other documents -
      // the protection certificates. Voucher Resend sends every document and the
      // breakdown of the total. Excluded: anything that asks for money back
      // (a refund question is a cancellation, handled above and below).
      { topic: 'VOUCHER_RESEND',
        re: /^(?![\s\S]*\b(?:refund\w*|reimburs\w*|rembours\w*|erstatt\w*|r[uü]ckerstatt\w*|rimbors\w*|reembols\w*|money\s+back|cancel\w*|annul\w*|stornier\w*))(?=[\s\S]*\b(?:d[eé]bit[eé]\w*|pr[eé]lev[eé]\w*|pr[eé]l[eè]vement|charged|debited|abgebucht|belastet|abgezogen|addebitat\w*|cobrad\w*|pay[eé]s?\b|paid|bezahlt|gezahlt|pagato|pagado|carte\s+(?:bancaire|bleue|de\s+cr[eé]dit)|credit\s+card|card\s+statement|kreditkarte|bank(?:ing)?\s+statement|relev[eé]\s+(?:bancaire|de\s+compte)|kontoauszug))(?=[\s\S]*(?:\bne\s+correspond|\bpas\s+le\s+m[eê]me|\bdiff[eé]ren\w*|\bplus\s+(?:cher|[eé]lev[eé])|\btrop\b|\bdoes\s*n.?t\s+match|\bdon.?t\s+understand|\bdo\s+not\s+understand|\bwhy\s+(?:was|were|have|did|is)\b|\bmore\s+than\b|\bhigher\s+than\b|\bstimmt\s+nicht|\bnicht\s+nachvollzieh\w*|\bverstehe\s+nicht|\bwarum\s+(?:wurde|ist|wird)\b|\bmehr\s+als\b|\bh[oö]her\b|\bzu\s+viel\b|\bnon\s+corrisponde|\bperch[eé]\b|\bno\s+coincide|\bpor\s+qu[eé]\b|\bcomprends\s+pas|\bcomprend\s+pas|\bexpli\w*|\berkl[aä]r\w*|\bbreakdown|\bd[eé]tail\w*|\bzusammensetz\w*|\baufschl[uü]sselung))/i },
      // The article is optional on purpose. "Cancel booking BT4WSA" is the way
      // customers actually write it, and requiring "my" or "the" meant the
      // keyword layer missed it and the whole decision fell to the model.
      // Three ways a customer asks for a cancellation, and the first version of
      // this rule only caught one of them.
      //
      // On 581832 the customer wrote "Please kindly cancel the second booking
      // under confirmation BCGUA7". The article was there, the noun was there -
      // but the word "second" sat between them, and the rule required them
      // adjacent. The keyword layer missed, the decision fell to the model, and
      // the model answered OTHER. A perfectly clear cancellation was routed to
      // nobody because of one adjective.
      //
      // So: allow up to two words between the article and the noun, and accept
      // "cancel <REFERENCE>" on its own - which is how customers write it once
      // they have quoted the reference earlier in the message.
      // ASKING WHAT A CANCELLATION WOULD COST IS NOT ASKING FOR ONE.
      //
      // "Quelles sont les conditions d'annulation de ma reservation BRXV5Z ?"
      // matched the cancellation rule - the noun "annulation", an article and
      // "reservation" are all there - and came out RUN, on a message that asks a
      // question and requests nothing. The answer is written down in the book
      // (CANCELLATION DEADLINE, CANCELLATION FEES), so it is a general question.
      //
      // The guard is the verb. If the customer anywhere writes "annuler",
      // "cancel", "stornieren", this rule steps aside and the cancellation rule
      // below takes it - because "I want to cancel, what would it cost?" IS a
      // cancellation request.
      { topic: 'GENERAL_QUESTION',
        re: /^(?=[\s\S]*(?:\b(?:conditions?|frais|politique|d[eé]lai|co[uû]t)\s+d.annulation|\bcancellation\s+(?:polic\w+|conditions?|fees?|charges?|deadline|terms|costs?)|\bstornobedingungen|\bstornogeb[uü]hr\w*))(?![\s\S]*\b(?:annuler|annulez|annulons|annule|cancel|cancelling|canceled|cancelled|stornieren|storniere)\b)/i },
      // ONE ITEM, NOT THE BOOKING. "Die Versicherung stornieren", "remove the
      // helmet", "annuler les skis de Paul" carry the cancel verb, so the rule
      // below read them as a FULL cancellation (581867: the handler then asked
      // the customer to confirm cancelling a booking she wanted to keep). A
      // cancel or remove verb next to an item word - a protection, an accessory,
      // one named person's equipment - is a partial cancellation, and it must be
      // decided before the whole-booking rule gets a look. A message that says
      // "whole", "entire", "toute la", "ganze" steps aside and stays full.
      { topic: 'PARTIAL_CANCELLATION',
        re: /^(?![\s\S]*\b(?:cover\w*|couvre|couvert|include\w*|inclu\w*|what\s+is|what\s+does|c.est\s+quoi|was\s+deckt|abgedeckt|kostet|co[uû]te|cost\w*)\b)(?![\s\S]*\b(?:whole|entire|complete|toute\s+la|toute\s+ma|enti[eè]re|ganze|gesamte|komplette|intera|completa|toda\s+la)\s+(?:booking|reservation|r[eé]servation|buchung|prenotazione|reserva)\b)(?![\s\S]*\b(?:cancel\w*|annul\w*|storn\w*|stornier\w*)\s+(?:of\s+)?(?:my|the|our|this|ma|la|notre|cette|meine|die|unsere|la\s+mia|mi)\s+(?:booking|reservation|r[eé]servation|order|buchung|prenotazione|reserva)\b)(?=[\s\S]*(?:\b(?:cancel\w*|annul\w*|storn\w*|stornier\w*|remove|removing|retir\w*|enlev\w*|supprim\w*|rausnehmen|raus|entfern\w*|streich\w*|delete|drop|rimuov\w*|elimin\w*|quitar)\b[\s\S]{0,60}\b(?:insurance|versicherung|assurance|protection|schutz|assicurazione|seguro|alpin\s*safety(?:\s+plus)?|alpin\s*guaranty|alpin\s*flexi|snow\s*flexi|snow\s*guaranty|ski\s*flexi|ski\s*guaranty|helmets?|casques?|helm|helme|boots?|chaussures?|schuhe|scarponi|botas|poles?|b[aâ]tons?|st[oö]cke|modelchange|one\s+(?:person|pair|item)|une\s+personne|une\s+paire|eine\s+person|ein\s+paar|(?:la\s+|le\s+|the\s+)?personne\s*(?:n[°o]\s*)?\d|person\s*(?:no\.?\s*)?\d|skier\s*\d|skieur\s*\d|(?:la\s+)?deuxi[eè]me\s+personne|(?:the\s+)?second\s+person|(?:die\s+)?zweite\s+person|one\s+of\s+(?:the\s+)?(?:people|persons|skiers)|un\s+des\s+skieurs|une\s+des\s+personnes|(?:skis?|snowboards?)\s+(?:for|of|de|pour|von|f[uü]r)\s+\w+)\b|\b(?:insurance|versicherung|assurance|protection|schutz|assicurazione|seguro|alpin\s*safety(?:\s+plus)?|alpin\s*guaranty|alpin\s*flexi|snow\s*flexi|snow\s*guaranty|ski\s*flexi|ski\s*guaranty|helmets?|casques?|helm|helme|boots?|chaussures?|schuhe|scarponi|botas|poles?|b[aâ]tons?|st[oö]cke|modelchange|one\s+(?:person|pair|item)|une\s+personne|une\s+paire|eine\s+person|ein\s+paar|(?:la\s+|le\s+|the\s+)?personne\s*(?:n[°o]\s*)?\d|person\s*(?:no\.?\s*)?\d|skier\s*\d|skieur\s*\d|(?:la\s+)?deuxi[eè]me\s+personne|(?:the\s+)?second\s+person|(?:die\s+)?zweite\s+person|one\s+of\s+(?:the\s+)?(?:people|persons|skiers)|un\s+des\s+skieurs|une\s+des\s+personnes|(?:skis?|snowboards?)\s+(?:for|of|de|pour|von|f[uü]r)\s+\w+)\b[\s\S]{0,40}\b(?:cancel\w*|annul\w*|storn\w*|stornier\w*|remove|removing|retir\w*|enlev\w*|supprim\w*|rausnehmen|raus|entfern\w*|streich\w*|delete|drop|rimuov\w*|elimin\w*|quitar)\b))/i },
      // REMOVING ONE PERSON OR ONE ITEM, IN THE OTHER LANGUAGES (11 septembre 2026).
      //
      // The rule above catches English and German. French, Italian, Spanish and
      // Dutch fell through to a full cancellation or to nothing at all: "annuler
      // les skis d'une seule personne", "annullate solo gli sci di Paul", "anulen
      // solo los esquis", "annuleer alleen de ski's van Paul".
      //
      // Three conditions, and all three are needed: a cancel word WITHIN SIXTY
      // CHARACTERS of an item word, a restrictor ("only", "seulement", "keep the
      // rest"), and no mention of the WHOLE booking. The restrictor list must not
      // contain a bare "just": on 542088 - "I just booked my ski rental 2 hours
      // ago and need to know how to cancel it" - that one word turned a full
      // cancellation into a partial one.
      //
      // Measured on the 314: no mail comes in from OTHER, and the two mails it
      // takes from CANCELLATION belong to it - 542118 ("I will not need a helmet
      // ... modify this portion") and 542258 ("cancel the reservation only for
      // Tom, Eyal, Rami and Eiytan are still coming").
      { topic: 'PARTIAL_CANCELLATION',
        re: /(?![\s\S]*\b(?:whole|entire|toute\s+la|ganze|intera|toda\s+la)\s+(?:booking|r[eé]servation|buchung|prenotazione|reserva)\b)(?=[\s\S]*(?:(?:cancel\w*|annul\w*|storn\w*|disdi\w*|anular|anulen|annuleer\w*|annuleren)[\s\S]{0,60}?(?:skis?|sci\b|esqu[ií]s?|snowboard\w*|planche\w*|casque\w*|helm\w*|casco\w*|chaussures?|boots?|schuhe|scarponi|botas|mat[eé]riel|ausr[uü]stung|attrezzatura|equipo|uitrusting)|(?:skis?|sci\b|esqu[ií]s?|snowboard\w*|planche\w*|casque\w*|helm\w*|casco\w*|chaussures?|boots?|schuhe|scarponi|botas|mat[eé]riel|ausr[uü]stung|attrezzatura|equipo|uitrusting)[\s\S]{0,60}?(?:cancel\w*|annul\w*|storn\w*|disdi\w*|anular|anulen|annuleer\w*|annuleren)))(?=[\s\S]*(?:\bonly\b|seulement|uniquement|ne\s+que|\bnur\b|\balleen\b|\bsolo\b|\bs[oó]lo\b|solamente|una\s+sola|une\s+seule|eine\s+einzige|keep\s+the\s+rest|garder\s+le\s+reste|der\s+rest\s+bleibt|de\s+rest\s+blijft|il\s+resto\s+resta|el\s+resto\s+se\s+queda|for\s+one\s+person|d.une\s+seule\s+personne|this\s+portion))/i },
      { topic: 'CANCELLATION',  re: /\b(cancel(?:l?ing|lation)?\s+(?:of\s+)?(?:my|the|our|these|those|this|that|both|all)?\s*(?:\w+\s+){0,2}(bookings?|reservations?|orders?|rentals?)|cancel(?:l?ing)?\s+(?:the\s+)?(?:booking\s+)?(?:under\s+(?:confirmation|reference)\s+)?B[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}|annul(?:er|ation|ations|[eé]e?s?)\s+(?:de\s+)?(?:ma|mes|la|les|notre|nos|cette|ces|deux)?\s*(?:\w+\s+){0,2}r[eé]servations?|storno\w*|stornier\w*)\b/i },
      // CANCELLING IN THE OTHER HALF OF EUROPE (11 septembre 2026).
      //
      // The rule above knows English, French and German. It knows nothing of
      // Italian, Dutch, Spanish, Danish or Polish - and until the quoted-text
      // cut was tightened, that gap was invisible: the confirmation e-mail
      // quoted underneath the customer's own words carried the missing keyword,
      // so these mails were routed CORRECTLY BY ACCIDENT. With the quote gone,
      // "Purtroppo sono costretta all'annullamento" and "ik zou graag boeking
      // BDZ36A willen annuleren" both fell through to the model.
      //
      // Measured on the 314 mails of 26 January: five mails move from OTHER to
      // CANCELLATION, every one of them a real cancellation, and the rule fires
      // on NO mail that another rule already routes.
      { topic: 'CANCELLATION',
        re: /\b(annullare|annullamento|annullazione|disdire|disdetta|cancellare\s+(?:la\s+|il\s+|l['’])?\s*(?:prenotazione|ordine|noleggio)|annuleren|annulering|annuleer|annuleert|anular\s+(?:mi\s+|la\s+)?reserva|cancelar\s+(?:mi\s+|la\s+)?reserva|annullere|afbestille|afbestilling|anulowa\w+|anulacj\w+)\b/i },
      // ASKING THE PRICE IN A LANGUAGE THAT GLUES ITS NOUNS TOGETHER (11 septembre 2026).
      //
      // The main QUOTE rule above works on "Ski Verleih" and fails on
      // "Skiverleih": its rental words are anchored with \b, and a German or
      // Dutch compound offers no boundary before the second half. Measured:
      // "was kostet der Ski Verleih" routes QUOTE, "was kostet der Skiverleih"
      // routes nothing. Dutch "huren" and "verhuur" were absent altogether, and
      // the head-count list knew adultes but not adulti, adultos, volwassenen.
      //
      // So: a price word and a rental word WITHIN THIRTY CHARACTERS of each
      // other - which is how the question is actually asked - plus a head count
      // or a date range. The proximity is what keeps a complaint out: 542789
      // ("een vraag over de kwaliteit van de ski's") has all three words spread
      // over a page, and matched until the distance was added.
      //
      // Not a new quote if the customer is talking about a booking they already
      // have - same guard as the rule above.
      { topic: 'QUOTE',
        re: /^(?![\s\S]*(?:\b[Bb][123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}\b|\b(?:my|our|meine?|unsere?|ma|notre|mon|mijn|onze|la\s+mia|mi)\s+(?:booking|buchung|r[eé]servation|reservierung|boeking|prenotazione|reserva)\b))(?=[\s\S]*(?:(?:kost\w*|preis\w*|prijs|prijzen|tarief|tarieven|prezz\w*|preci\w*|cuesta|cost[ao]|quanto\s+cost\w*|angebot|offerte|preventivo|presupuesto)[\s\S]{0,30}?(?:verleih\w*|vermiet\w*|mieten|verhuur\w*|huren|huur\b|noleggi\w*|affitt\w*|alquil\w*)|(?:verleih\w*|vermiet\w*|mieten|verhuur\w*|huren|huur\b|noleggi\w*|affitt\w*|alquil\w*)[\s\S]{0,30}?(?:kost\w*|preis\w*|prijs|prijzen|tarief|tarieven|prezz\w*|preci\w*|cuesta|cost[ao]|quanto\s+cost\w*|angebot|offerte|preventivo|presupuesto)))(?=[\s\S]*(?:\d{1,3}\s*(?:erwachsene\w*|kinder|personen|volwassene\w*|kinderen|adulti|bambini|persone|adultos|ni[nñ]os|personas)\b|(?:vom|van|dal|del)\s+\d{1,2}\.?\s*(?:bis|tot|al)\s+\d{1,2}))/i },
      // The voucher, asked for in Spanish (11 septembre 2026). "bono" and
      // "reenviar" were the two words missing; every other language already
      // routed this correctly.
      { topic: 'VOUCHER_RESEND',
        re: /\b(?:reenv[ií]\w*|volver\s+a\s+enviar|env[ií]en?me)\b[\s\S]{0,40}?\b(?:bono|comprobante|confirmaci[oó]n|justificante)\b|\b(?:bono|comprobante|justificante)\b[\s\S]{0,40}?\b(?:reserva|alquiler)\b[\s\S]{0,60}?\b(?:reenv[ií]\w*|enviar|mandar)\b/i },
      // A double booking IS a cancellation request, and it is one of the most
      // common ones: the payment page errored, the customer tried again, and now
      // they hold two. Nothing about that sentence says "cancel my booking" in
      // the shape above, so it used to fall through to the model - and the model
      // called it OTHER. The pairing is what makes it safe: the word duplicate
      // alone is a statement, duplicate plus a cancel or refund word is a request.
      { topic: 'CANCELLATION',
        re: /\b(duplicate|duplicated|double|twice|two\s+(?:identical|same)\s+bookings?|en\s+double|deux\s+fois|doppelt|doppelte)\b[\s\S]{0,300}\b(cancel\w*|annul\w*|storn\w*|refund\w*|rembours\w*|erstatt\w*)/i },
      { topic: 'DATE_CHANGE',   re: /\b(change\s+(my|the)\s+dates?|move\s+(my|the)\s+booking|postpone|d[eé]caler|changer\s+(mes|les)\s+dates?|different\s+dates?)\b/i },
      // "Pouvez-vous modifier la reservation svp ? je me suis trompee de date"
      //
      // 581870, and it came out OTHER: the rule above wants the word "dates"
      // next to the verb, and this customer put the verb on the booking and the
      // date on the mistake. Two halves are required so that "modifier ma
      // reservation" (a name, an email, a shoe size) is not swept in: a change
      // verb AND something that says the change is about the period.
      { topic: 'DATE_CHANGE',
        re: /(?=[\s\S]*\b(modifier|changer|d[eé]caler|reporter|repousser|avancer|change|move|amend|umbuchen|[aä]ndern|cambiare|cambiar)\b)(?=[\s\S]*(\b(dates?|p[eé]riode|jours?|semaine|s[eé]jour|datum|termin|periodo|fechas?)\b|\b(?:tromp[eé]e?|erreur|mauvaise?|wrong|falsch|sbagliat\w+|equivocad\w+)\s+(?:de\s+)?(?:dates?|datum|fechas?)\b|\bme\s+suis\s+tromp[eé]e?\s+de\s+date))/i },
      // CHANGING THE DATES WHEN THE VERB AND THE NOUN ARE GLUED OR FOREIGN
      // (11 septembre 2026).
      //
      // The rule above knows "datum" but not its German plural "Daten", and
      // knows no Dutch verb at all: "die Daten meiner Buchung aendern" and "de
      // data van mijn boeking wijzigen" both routed nowhere.
      //
      // The verb must sit WITHIN 45 CHARACTERS of the date noun. Without that
      // distance the rule fires on 542481 - "de ski's veranderen van beginner
      // naar gevorderd" for a booking made "voor de periode van 1-5 maart",
      // which is an upgrade, not a date change. Measured with the distance:
      // 542536 ("den Zeitraum aendern von 02.05. - 05.05.") is picked up, and
      // no mail that another rule routes is taken away - the voucher rules sit
      // above this one and keep the four mails that mention both.
      { topic: 'DATE_CHANGE',
        re: /^(?![\s\S]*\b(?:beginner|anf[aä]nger|gevorderd|advanced|intermediate|expert|niveau\w*|level|modell?|modello|modelo)\b)(?=[\s\S]*(?:(?:[aä]ndern|umbuchen|verschieben|wijzig\w*|aanpass\w*|verzett\w*|verander\w*|[æa]ndre|flytte|zmieni\w*)[\s\S]{0,45}?(?:daten|datum|data|dagen|periode|zeitraum|termin\w*|reisedaten|huurperiode)|(?:daten|datum|data|dagen|periode|zeitraum|termin\w*|reisedaten|huurperiode)[\s\S]{0,45}?(?:[aä]ndern|umbuchen|verschieben|wijzig\w*|aanpass\w*|verzett\w*|verander\w*|[æa]ndre|flytte|zmieni\w*)))/i },
      // REQUOTE is re-pricing a booking that already exists, so it sits AFTER
      // DATE_CHANGE: a customer moving their dates wants the date-change flow,
      // not a new price. What lands here is adding days, adding people or
      // adding equipment - the cases where the basket changes and the total has
      // to be recalculated.
      //
      // No reference is required to match. ROUTES.REQUOTE demands booking_ref
      // before the flow may run, so a customer who asks without one is asked
      // for it instead of being handed over - which is the behaviour we want.
      // A SKIER'S DETAILS ON AN EXISTING BOOKING (581982).
      //
      // "My son has grown - height is now 142 cm, weight 38 kg, boot size 37.
      // Can you update this?" matched nothing and died as "No capability
      // matches this message" - while Odin exposes exactly this update. A body
      // measurement, a shoe size, a level, a date of birth or a person's name,
      // next to a change verb (or a stated new value), is the Skier details
      // flow. Dates and equipment are excluded: those are DATE_CHANGE / REQUOTE.
      { topic: 'PERSONAL_INFO',
        re: /(?=[\s\S]*\b(?:height|weight|shoe\s*size|boot\s*size|foot\s*size|taille|poids|pointure|gr[oö][sß]e|gewicht|schuhgr[oö][sß]e|altezza|peso|numero\s+di\s+scarpe|estatura|talla|skier\s+details|skier\s+information|personal\s+(?:details|information|data)|donn[eé]es\s+personnelles|pers[oö]nliche\s+(?:daten|angaben)|(?:ski\s+)?level|niveau|(?:ski)?niveau|date\s+of\s+birth|birth\s*date|date\s+de\s+naissance|geburtsdatum|\d{2,3}\s*cm\b|\d{2,3}\s*kg\b|\d{2,3}\s*lbs?\b))(?=[\s\S]*(?:^|[^a-zA-Z])(?:updat\w*|chang\w*|correct\w*|modif\w*|adjust\w*|fix\b|wrong|mistake|error|typo|grown|grew|mettre\s+[aà]\s+jour|changer|corriger|rectifier|erreur|grandi|[aä]ndern|aktualisier\w*|korrigier\w*|falsch|fehler|gewachsen|aggiorn\w*|cambiar|corregir|actualizar|is\s+now\b|are\s+now\b|now\s+\d|fait\s+maintenant|mesure\s+maintenant|ist\s+jetzt|misst\s+jetzt))(?![\s\S]*\b(?:cancel\w*|annul\w*|stornier\w*|refund\w*|rembours\w*))/i },
      // SKIER DETAILS, IN ITALIAN (11 septembre 2026).
      // The rule above lists altezza and numero di scarpe, but its verb list has
      // correct\w* - which does not match "correggere". One conjugation, and
      // "Devo correggere altezza e numero di scarpe" routed nowhere.
      { topic: 'PERSONAL_INFO',
        re: /(?=[\s\S]*\b(?:corregg\w*|correzion\w*|modificar\w*|aggiornar\w*|sbagliat\w*)\b)(?=[\s\S]*\b(?:altezza|peso|numero\s+di\s+scarpe|scarponi|taglia|livello)\b)/i },
      { topic: 'REQUOTE',       re: /\b(add\s+(?:\d+\s+)?(?:more\s+)?(?:days?|nights?)|extend\s+(?:my|the|our)\s+(?:booking|reservation|rental|stay)|prolonger\s+(?:ma|la|notre)\s+(?:r[eé]servation|location)|ajouter\s+(?:\d+\s+)?(?:jours?|nuits?)|add\s+(?:a\s+|an\s+|the\s+|another\s+|one\s+|\d+\s+)?(?:more\s+)?(?:skis?|snowboards?|persons?|people|adults?|child(?:ren)?|skiers?)\s+to\s+(?:my|the|our)\s+(?:booking|reservation|rental)|re-?quote|nouveau\s+devis)\b/i },
      // Helmets, boots and protections added to an EXISTING booking: the General
      // questions flow rebuilds the cart with the addon and answers the customer
      // with the link (ticket 581843). REQUOTE would only leave an internal note.
      { topic: 'GENERAL_QUESTION',
        re: /\b(add|ajouter|rajouter|hinzuf[uü]gen|dazubuchen|nachbuchen|aggiungere|a[nñ]adir)\b[\s\S]{0,40}\b(helmets?|casques?|helm\w*|boots?|chaussures?|schuhe|scarponi|botas)\b[\s\S]{0,60}\b(booking|reservation|r[eé]servation|buchung|prenotazione|reserva)\b/i },
      // ABOVE 'QUOTE' deliberately: "combien coute Alpinguaranty ?" contains
      // the quote trigger word, but naming a protection makes it a question
      // about a product, not a request for a price on a rental.
      // Two shapes a single word list cannot catch: a question about what a
      // protection covers, and the day-before pick-up, where the words are
      // always separated by whatever the customer is collecting.
      { topic: 'GENERAL_QUESTION',
        re: /\b(alpinflexi|snowflexi|alpinguaranty|alpinsafety(\s+plus)?)\b[\s\S]{0,60}\b(cover\w*|include\w*|couvre|comprend|inclut|what\s+is|c.est\s+quoi|price|prix|co[uû]te|cost)\b|\b(cover\w*|couvre|price|prix|co[uû]te|cost|what\s+is)\b[\s\S]{0,60}\b(alpinflexi|snowflexi|alpinguaranty|alpinsafety(\s+plus)?)\b/i },
      { topic: 'QUOTE',         re: /\b(quote|devis|how\s+much\s+would|combien\s+co[uû]te|price\s+for\s+\d|offre\s+de\s+prix)\b/i },
      // TICKET 581888. "We are a group of 7 skiing in Bad Hofgastein from 10th
      // to 15th January 2027 - do you have a discount code?" matched NOTHING,
      // and the ticket died with "No capability matches this message". Yet it is
      // the purest form of prospect we get: a resort, a week in January, seven
      // pairs of skis, and not one occurrence of the word "quote".
      //
      // Customers describe their trip; they do not ask for a "quote". These two
      // rules read the description instead of waiting for the magic word.
      //
      // They sit BELOW every rule that acts on an existing booking - cancel,
      // date change, requote - so "we are a group of 7 and we need to cancel"
      // is still a cancellation. That ordering is what makes them safe to write
      // this broadly.
      { topic: 'QUOTE',
        re: /\b(?:we\s+are|we.re|nous\s+sommes|on\s+est|wir\s+sind|siamo|somos)\s+(?:a\s+|un\s+|une\s+|eine\s+)?(?:group|groupe|gruppe|gruppo|grupo|family|famille|familie|party)?\s*(?:of\s+|de\s+|von\s+|di\s+)?\d{1,3}\b[\s\S]{0,200}\b(ski\w*|snowboard\w*|surf|louer|location|mieten|noleggi\w*|alquil\w*)\b|\b(?:group|groupe|gruppe|gruppo|grupo|party)\s+(?:of|de|von|di)\s+\d{1,3}\b[\s\S]{0,200}\b(ski\w*|snowboard\w*|surf|louer|location|mieten)\b/i },
      { topic: 'QUOTE',
        re: /\b(?:need|needing|looking\s+for|would\s+like|want\s+to|wish\s+to|interested\s+in|cherch\w*|souhait\w*|voudrai\w*|aimerai\w*|besoin\s+de|m[oö]chte\w*|brauche\w*|suche\w*|interessiert)\b[\s\S]{0,80}\b(?:rent(?:al|ing)?|hire|hiring|louer|location\s+de|mieten|verleih|noleggi\w*|alquil\w*)\b[\s\S]{0,80}\b(?:skis?|snowboards?|equipment|mat[eé]riel|ausr[uü]stung|attrezzatura|equipo)\b|\b(?:rent|hire|louer|mieten|noleggiare|alquilar)\b[\s\S]{0,60}\b(?:skis?|snowboards?|equipment|mat[eé]riel)\b[\s\S]{0,120}\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:to|-|au|bis|al)\s+\d{1,2}|from\s+\d{1,2}|du\s+\d{1,2}|vom\s+\d{1,2})\b/i },
      // LAST, always. Everything above is a request that changes something; what
      // is left is a question, and a question has an answer written down.
      //
      // These patterns are the ones the training set shows over and over. They
      // are deliberately narrow - a wrong match here sends a real request to a
      // flow that only knows how to talk, which is the one failure mode that
      // matters. When none of them matches, the topic stays OTHER and a human
      // gets the ticket, exactly as today.
      { topic: 'GENERAL_QUESTION',
        re: /\b(invoice|facture|rechnung|receipt\s+for\s+(?:my|the)\s+(?:booking|rental)|ski\s+poles?|b[aâ]tons?\s+de\s+ski|poles?\s+(?:are\s+)?included|american\s+express|amex|payment\s+methods?|moyens?\s+de\s+paiement|zahlungsarten|child(?:ren)?\s+for\s+free|enfant\s+gratuit|kind\s+gratis|opening\s+hours|horaires?\s+d.ouverture|[oö]ffnungszeiten|what\s+is\s+included|qu.est[- ]ce\s+qui\s+est\s+inclus|own\s+(?:ski\s+)?boots|mes\s+propres\s+chaussures|specific\s+model|mod[eè]le\s+(?:pr[eé]cis|particulier)|add\s+(?:the\s+|a\s+|an\s+)?(?:insurance|protection|cover(?:age)?|alpin\s*flexi|snow\s*flexi|alpin\s*guaranty|snow\s*guaranty|ski\s*guaranty|ski\s*flexi|alpin\s*safety|slope\s*flex|slope\s*guaranty)|(?:ajouter|rajouter|souscrire|prendre)\s+(?:(?:l.|la\s+|le\s+|une\s+|un\s+)?)(?:assurance|protection|garantie|alpin\s*flexi|snow\s*flexi|alpin\s*guaranty|snow\s*guaranty|ski\s*guaranty|ski\s*flexi|alpin\s*safety|slope\s*flex|slope\s*guaranty)|(?:versicherung|schutz|alpin\s*flexi|snow\s*flexi|alpin\s*guaranty|alpin\s*safety)[\s\S]{0,40}(?:hinzuf[uü]gen|nachbuchen|dazubuchen)|(?:hinzuf[uü]gen|nachbuchen|dazubuchen)[\s\S]{0,40}(?:versicherung|schutz|alpin\s*guaranty)|aggiungere\s+(?:l.|la\s+|una\s+|un\s+)?(?:assicurazione|protezione|alpin\s*guaranty|alpin\s*flexi)|a[nñ]adir\s+(?:el\s+|la\s+|un\s+|una\s+)?(?:seguro|protecci[oó]n|alpin\s*guaranty|alpin\s*flexi)|ski\s+(?:lessons?|school)|cours\s+de\s+ski|skikurs|rent\s+(?:ski\s+)?clothing|location\s+de\s+v[eê]tements|lift\s+pass|forfait\s+de\s+ski|skipass|priority\s+check.?in|modelchange\s+option)\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(pick\s*.?up|collect|r[eé]cup[eé]rer|abhol\w*)\b[\s\S]{0,40}\b(day\s+before|evening\s+before|la\s+veille|vortag|tag\s+davor)\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(helmets?|casques?|helm\w*)\b[\s\S]{0,40}\b(compulsory|mandatory|obligatoire|obligatorisch|pflicht|required\s+by\s+law)\b|\bhelmpflicht\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(promo(?:tion)?\s+code|code\s+promo|gutschein\s?code|discount\s+code)\b[\s\S]{0,40}\b(does\s+not|doesn.t|not\s+work\w*|invalid|refus\w*|ne\s+(?:fonctionne|marche)\s+pas|funktioniert\s+nicht)\b/i },
      // "Do you have a code for next year?" - asking FOR a code, not reporting a
      // broken one. The rule above only knew the broken case, so 581888 fell
      // through here too. We do have a code, and it is already in the quote.
      { topic: 'GENERAL_QUESTION',
        re: /\b(promo(?:tion)?\s*code|code\s+promo|discount\s+code|voucher\s+code|rabatt\s?code|gutschein\s?code|codice\s+sconto|c[oó]digo\s+(?:de\s+)?descuento)\b|\b(?:discount|r[eé]duction|remise|rabatt|sconto|descuento)\b[\s\S]{0,30}\b(?:code|coupon)\b/i },
      // Delivery, and how the shop types differ.
      //
      // Added once the answer book learned to answer them. Before that these
      // landed as "no capability" and a human wrote the same paragraph again:
      // the router has to know a question is answerable, or the answer might as
      // well not exist. The delivery words are paired with an equipment or
      // accommodation word on purpose - "livraison" alone also means the parcel
      // a shop is waiting for, and that is not this.
      { topic: 'GENERAL_QUESTION',
        re: /\b(deliver\w*|livr\w*|liefer\w*|zustell\w*|drop.?off|d[eé]pose\w*)\b[\s\S]{0,60}\b(accommodation|apartment|appartement|apart\w*|hotel|h[oô]tel|chalet|residence|r[eé]sidence|unterkunft|ferienwohnung|lodging|equipment|mat[eé]riel|skis?|ski\s+set|ausr[uü]stung)\b|\b(accommodation|apartment|appartement|hotel|h[oô]tel|chalet|unterkunft)\b[\s\S]{0,60}\b(deliver\w*|livr\w*|liefer\w*)\b/i },
      { topic: 'GENERAL_QUESTION',
        re: /\b(top.?shop|best\s+offer|virtual\s+shop|magasin\s+virtuel)\b|\b(difference|diff[eé]rence|unterschied)\b[\s\S]{0,50}\b(shops?|magasins?|gesch[aä]ft\w*|l[aä]den)\b/i },
];

/**
 * Layer 0 - who is writing.
 *
 * Added after this file was first tested: on the 581628 fixture (a colleague
 * forwarding "WG: Verleihpreise FW 26/27") the tag layer was silent, the
 * keyword layer was silent, and the model's guess of DATE_CHANGE was trusted -
 * so the endpoint would have had a flow ask a Sales rep for their booking
 * reference. Exactly the bug it exists to prevent.
 *
 * The reliable discriminator is not the subject, it is the sender: internal and
 * partner mail carries its own signature in the body. No topic, no matter how
 * confident, survives this check - a colleague sending a price list is not a
 * customer request, whatever it looks like.
 */
/**
 * Our own domains. Matched against WHO SENT the message, never against what the
 * message contains.
 *
 * This distinction cost us ticket 581697. The markers below used to be tested
 * against the body, and the body of every reply to one of our emails quotes our
 * own footer - "bd@alpy.com", "Powered by 2beGROUP". So a customer answering
 * "please cancel my booking" was read as internal mail, the endpoint returned
 * STOP, and the gatekeeper stayed silent instead of asking for the booking
 * reference. The customer got nothing.
 *
 * The rule that survives: a sender is internal because of their address, not
 * because our address appears somewhere in their email.
 */
const INTERNAL_DOMAINS = [
      /@alpy\.com\s*$/i,
      /@2begroup/i,
      /@alpinresorts/i,
      /@skirent-booking/i,
];

/**
 * Body markers that a quoted signature can NOT produce.
 *
 * "WG:" and "TR:" are forward prefixes: they belong to the very start of a
 * subject line, so they are anchored. Anything found deeper in the text is a
 * quotation of an older message and proves nothing about this sender.
 */
const FORWARD_PREFIX = /^\s*(WG|TR|FW|FWD)\s*:/i;

function detectInternalSender(message, senderEmail, subject) {
      const from = String(senderEmail || '').trim();
      if (from && INTERNAL_DOMAINS.some(re => re.test(from))) {
              return { topic: 'OTHER', source: 'internal_sender', blocked: true };
      }

      // The subject carries the forward prefix far more often than the body.
      //
      // Found on 581757: a partner shop forwarded "FW: Alpy.com: Neue Buchung
      // eingegangen!" and wrote "bitte buchungen stoppen" underneath. The body's
      // first line was "Hallo", so this check passed it through, the flow read a
      // cancellation, and we replied to the SHOP offering to cancel a CUSTOMER's
      // booking by name. The booking was not theirs to cancel.
      //
      // The subject is the one place a forward always announces itself.
      if (FORWARD_PREFIX.test(String(subject || ''))) {
              return { topic: 'OTHER', source: 'forwarded_mail', blocked: true };
      }

      // Only the first line of the body is eligible - a forward prefix lives
      // there or nowhere. Scanning the whole body would match every quoted thread.
      const firstLine = String(message || '').split(/\r?\n/).find(l => l.trim() !== '') || '';
      if (FORWARD_PREFIX.test(firstLine)) {
              return { topic: 'OTHER', source: 'forwarded_mail', blocked: true };
      }

      // A company writing to us about the season, not a customer writing about a trip.
      //
      // Same ticket: a legal-entity signature (GmbH, UID, FN) with a message about
      // stopping bookings and agreeing conditions before the season. That is a
      // partner negotiating commercial terms. No flow should answer it, and the
      // cancellation flow least of all - "stop the bookings" is not "cancel mine".
      const body = String(message || '');
      const hasCompanySignature =
              /\b(gmbh|s\.?r\.?o\.?|s\.?a\.?r\.?l\.?|ltd\b|b\.?v\.?|a\.?g\b|UID\s*[A-Z]{2}|FN\s*\d{4,}|VAT\s*(?:no|number|ID))/i.test(body);
      const talksBusiness =
              /\b(buchungen\s+stoppen|stop\s+(?:all\s+)?bookings|arr[eê]ter\s+les\s+r[eé]servations|konditionen|conditions?\s+for\s+(?:the\s+)?(?:next\s+)?season|vor\s+der\s+saison|preise\s+(?:bekannt|festgelegt)|tarifs?\s+(?:de\s+la\s+)?saison|commission|vertrag|contract)\b/i.test(body);
      // A SHOP TALKING ABOUT "YOUR CLIENTS" IS NOT A CLIENT (542205).
      //
      // Pic Negre wrote "This is to inform your clients, and to note on the
      // vouchers that arrive at the shops, that if any of your clients pick up
      // the equipment the day before...". It has no company signature and no
      // commercial vocabulary, so the two tests above both missed it, and
      // General questions answered a partner as if he were a holidaymaker.
      //
      // A customer never writes "your clients". The phrase names our customers
      // in the third person, which only someone on our side of the counter does.
      // Measured on the 314 mails of 26 January: exactly one match, this one.
      const speaksOfOurCustomers =
              /\b(your|vos|ihre|uw|i vostri|sus)\s+(clients?|customers?|kunden|klanten|clienti)\b/i.test(body);
      if ((hasCompanySignature && talksBusiness) || speaksOfOurCustomers) {
              return { topic: 'OTHER', source: 'partner_business', blocked: true };
      }

      return null;
}

function detectFromTags(tags) {
      const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
      const clean = list.map(t => String(t || '').trim()).filter(Boolean);
      if (clean.some(t => NEVER_ANSWER.includes(t))) {
              return { topic: 'OTHER', source: 'native_tag_never_answer', blocked: true };
      }
      for (const t of clean) {
              if (TAG_TO_TOPIC[t]) return { topic: TAG_TO_TOPIC[t], source: 'native_tag', blocked: false };
      }
      return null;
}

function detectFromKeywords(message) {
      // The TOPIC is decided on what the customer wrote, never on what they
      // forwarded. 581870: our own confirmation email, quoted underneath a
      // date-change request, carries the word "annuler" - and that word alone
      // turned the request into a cancellation. The reference extraction still
      // reads the whole text; only the verb that decides the route is taken from
      // the customer's own words.
      const m = stripQuotedAndSignature(String(message || ''));
      if (m.trim().length < 3) return null;
      for (let i = 0; i < KEYWORDS.length; i++) {
              const k = KEYWORDS[i];
              // The index of the rule that fired travels with the decision. Without
              // it, diagnosing a mis-route means guessing which of some eighty
              // regexes matched - which is exactly how the nine mails of 10
              // September stayed unexplained for an afternoon.
              if (k.re.test(m)) return { topic: k.topic, source: 'keyword', rule: i, blocked: false };
      }
      return null;
}

/**
 * Every topic the keyword layer recognises in this message, not just the first.
 *
 * ONE MESSAGE, TWO CHANGES (582063). "Cancel person 1: test test AND shift the
 * dates by one day" was routed to Date Change alone: the dates were looked at,
 * the person stayed on the booking, and the ticket was tagged answered. A flow
 * that performs half of what was asked and closes the subject is worse than one
 * that does nothing, because nobody comes back to it.
 *
 * Only the topics that CHANGE a booking are counted here. A quote next to a
 * question, or a voucher next to a general question, are read-only and safe to
 * answer one at a time.
 */
const MUTATING_TOPICS = ['CANCELLATION', 'PARTIAL_CANCELLATION', 'DATE_CHANGE', 'PERSONAL_INFO', 'DEPOT_SWITCH', 'DUPLICATE_BOOKING'];

function mutatingTopicsIn(message) {
      const m = stripQuotedAndSignature(String(message || ''));
      if (m.trim().length < 3) return [];
      const found = [];
      for (const k of KEYWORDS) {
              if (MUTATING_TOPICS.indexOf(k.topic) === -1) continue;
              if (found.indexOf(k.topic) > -1) continue;
              if (k.re.test(m)) found.push(k.topic);
      }
      return found;
}

/**
 * A BIG GROUP IN FRANCE IS NEVER QUOTED BY US (582110).
 *
 * Benjamin's rule: more than fifty people in France goes to Skitruck
 * (alpy@skitruck.fr, Fabien in copy), never to an automatic quote. The rule was
 * implemented, but in the wrong place - inside the Quote Generator, which only
 * runs once the gatekeeper has everything it needs. A request for 68 people in
 * Val Thorens arrived with dates missing, so the gatekeeper asked its slot
 * question first and answered about boots, helmets and damage cover. The group
 * rule never got a turn.
 *
 * So it moves here, in front of the ASK. The country comes from the shop table
 * we already download for place resolution, matched on the town the customer
 * named - and the town lookup only happens once a headcount above fifty has
 * been found, so a loose town match can never affect an ordinary message.
 */
const BIG_GROUP_MIN = 50;

/** The largest headcount the customer states next to a word for people. */
function statedGroupSize(message) {
  const m = deaccent(stripQuotedAndSignature(String(message || '')));
  const WORD = 'personnes?|people|persons?|pax|adultes?|adults?|skieurs?|skiers?|participants?|teilnehmer|personen|erwachsene|persone|personas';
  let best = 0;
  const forward = new RegExp('\\b(\\d{2,4})\\s*(?:' + WORD + ')\\b', 'gi');
  const backward = new RegExp('\\b(?:groupe|group|gruppe|gruppo|grupo)\\s+(?:de\\s+|of\\s+|von\\s+)?(\\d{2,4})\\b', 'gi');
  for (const re of [forward, backward]) {
    let hit;
    while ((hit = re.exec(m)) !== null) {
      const n = parseInt(hit[1], 10);
      if (Number.isFinite(n) && n > best && n < 5000) best = n;
    }
  }
  return best;
}

async function franceBigGroup(message) {
  const size = statedGroupSize(message);
  if (size <= BIG_GROUP_MIN) return null;
  await loadShopPlaces();
  if (!_shopTowns || !_shopTowns.size) return { size, town: '', country: '' };
  const hay = deaccent(stripQuotedAndSignature(String(message || '')));
  let found = null;
  for (const [town, country] of _shopTowns) {
    const at = hay.indexOf(town);
    if (at < 0) continue;
    const before = at === 0 ? ' ' : hay.charAt(at - 1);
    const after = hay.charAt(at + town.length) || ' ';
    if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
    // Longest town name wins: "val thorens" over a shorter town inside it.
    if (!found || town.length > found.town.length) found = { town, country };
  }
  return { size, town: found ? found.town : '', country: found ? found.country : '' };
}

/**
 * MONEY TAKEN, NOTHING TO SHOW FOR IT (582095).
 *
 * "I booked a snowboard... and have not received any payment or booking
 * reference or confirmation yet payment has been taken." There is no capability
 * for this, and there should not be one: either the booking exists and someone
 * has to find out why its confirmation never went out, or it does not exist and
 * a customer has been charged for nothing. Both are a person's job, and both
 * are urgent in a way a queue position does not capture.
 *
 * Before this rule the message matched the duplicate-booking keywords instead,
 * and the flow that cancels and refunds a duplicate started up on a customer
 * who had no booking at all. Recognising the shape explicitly is what stops it
 * being read as something else again.
 */
const PAID_NO_BOOKING_RE = /(?=[\s\S]*\b(?:paid|payment|paiement|pay[eé]\w*|charged|d[eé]bit[eé]\w*|abgebucht|zahlung|bezahlt|pagato|pagado)\b)(?=[\s\S]*\b(?:not|never|no|n.ai\s+pas|jamais|nicht|kein\w*|aucun\w*|senza|sin)\b[\s\S]{0,60}\b(?:received|receiv\w*|re[cç]u\w*|erhalten|bekommen|got|arriv\w*)\b[\s\S]{0,90}\b(?:confirmation|booking\s+reference|booking\s+number|voucher|buchungsnummer|best[aä]tigung|num[eé]ro\s+de\s+r[eé]servation|conferma|confirmaci[oó]n)\b)/i;

function paidButNoBooking(message) {
  const m = stripQuotedAndSignature(String(message || ''));
  return PAID_NO_BOOKING_RE.test(m);
}

/**
 * "COULD I PLEASE SPEAK TO A COLLEAGUE" - and nothing else matters.
 *
 * 582070. The first reply was wrong, so the customer wrote back with the whole
 * price table, said she did NOT want to rebook her order, and asked to speak to
 * a person. She got a second automatic reply: a fresh quote for all six of them,
 * 548.80 EUR, the exact thing she had just refused. There was no rule for this
 * at all - a customer asking for a human was routed on the rest of her sentence
 * like any other message.
 *
 * A request for a person is not a topic among others. It outranks every route,
 * however confident the classifier is, because the one thing the customer has
 * told us plainly is that they no longer want to talk to a machine. Answering it
 * with anything automatic is the fastest way to lose a booking that was already
 * paid for.
 *
 * Read from the customer's own words only - quoted mail and our footer are
 * stripped first, and our own sign-off ("a colleague can take over at any time")
 * cannot match: every branch below needs a verb of speaking in front of it.
 */
const WANTS_HUMAN_RE = /\b(?:(?:speak|talk|chat|deal)\s+(?:to|with)\s+(?:a\s+|an\s+|the\s+|one\s+of\s+(?:your|the)\s+)?(?:real\s+|actual\s+|live\s+|human\s+)?(?:person|people|human|humans|colleague|colleagues|agent|advisor|adviser|operator|someone|somebody|staff|team\s+member|member\s+of\s+(?:your|the)\s+team)|parler\s+(?:[aà]|avec)\s+(?:quelqu.?un|une\s+(?:vraie\s+)?personne|un\s+(?:vrai\s+)?humain|un\s+conseiller|une\s+conseill[eè]re|un\s+agent|un\s+collaborateur|un\s+coll[eè]gue|un\s+op[eé]rateur)|mit\s+(?:einem|einer)\s+(?:mitarbeiter\w*|person|menschen|kollegen|kollegin|berater\w*)\s+(?:sprechen|reden)|parlare\s+con\s+(?:una\s+persona|un\s+operatore|un\s+collega|qualcuno)|hablar\s+con\s+(?:una\s+persona|un\s+agente|un\s+operador|alguien)|(?:are\s+you|is\s+this)\s+(?:a\s+)?(?:bot|robot|an\s+ai|a\s+machine)|not\s+a\s+(?:bot|robot|machine)|human\s+(?:agent|being|please)|vrai\s+humain|echten\s+menschen)\b/i;

function wantsHuman(message) {
      const m = stripQuotedAndSignature(String(message || ''));
      return WANTS_HUMAN_RE.test(m);
}

/* ==========================================================================
 * Reading a rental request written the way people actually write one.
 *
 * WHY THIS EXISTS (582304, and the several hundred mails a season shaped like
 * it). Emma wrote, in four lines: the resort, the dates, who was coming, and
 * both levels. Everything a quote needs. The extractor found none of it,
 * because it only ever read ISO dates and booking references, so the flow
 * reported six missing slots, the anti-loop guard saw a second turn with the
 * same holes, and the mail went to a human without a single automatic reply.
 *
 * What defeated it, line by line:
 *
 *   "Astenblick Apartment in Winterberg, Germany"  the resort is buried in the
 *                                                  name of a holiday flat
 *   "26-02  -  01-03"                              day-month, no year, spaced
 *   "just for me and my husband"                   a headcount with no digit
 *   "I am 1.73 m, Intermediate / He is 1.98 m"     levels attached to heights
 *
 * None of that is exotic. It is how a customer writes. So the rule for
 * everything below is: read what people write, in the six languages we serve,
 * and take nothing we are not sure of - a wrong date or a wrong headcount is a
 * wrong price, which is worse than a question.
 * ========================================================================== */

/** Accent-free lower case, for matching only. Never for output. */
function flat(x) {
      return String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Month names in the six languages we answer in, plus the abbreviations that
// turn up in real mail. Keys are accent-free.
const MONTH_WORDS = {
      jan: 1, january: 1, janvier: 1, januar: 1, januari: 1, gennaio: 1, enero: 1, ene: 1, genn: 1,
      feb: 2, february: 2, fevrier: 2, fev: 2, februar: 2, februari: 2, febbraio: 2, febrero: 2, febr: 2,
      mar: 3, march: 3, mars: 3, marz: 3, maerz: 3, maart: 3, marzo: 3,
      apr: 4, april: 4, avril: 4, avr: 4, aprile: 4, abril: 4,
      may: 5, mai: 5, mei: 5, maggio: 5, mayo: 5, magg: 5,
      jun: 6, june: 6, juin: 6, juni: 6, giugno: 6, junio: 6, giu: 6,
      jul: 7, july: 7, juillet: 7, juli: 7, luglio: 7, julio: 7, lug: 7, juil: 7,
      aug: 8, august: 8, aout: 8, augustus: 8, agosto: 8, ago: 8, ag: 8,
      sep: 9, sept: 9, september: 9, septembre: 9, settembre: 9, septiembre: 9, set: 9, settembr: 9,
      oct: 10, october: 10, octobre: 10, oktober: 10, ottobre: 10, octubre: 10, ott: 10, okt: 10,
      nov: 11, november: 11, novembre: 11, noviembre: 11,
      dec: 12, december: 12, decembre: 12, dezember: 12, dicembre: 12, diciembre: 12, dic: 12, dez: 12, dicembr: 12,
};

/**
 * The bookable window, and the whole reason a year is optional.
 *
 * Benjamin's rule, stated plainly: a customer can only book from now until the
 * end of June 2027, and 100% of them want a date inside that window. So a
 * customer who writes "26-02" has told us the date - there is exactly one
 * 26 February in the window, and asking which year would be asking them to
 * confirm the only possible answer.
 *
 * Same computation as generate-quote.js, on purpose: the two must never
 * disagree about which season we are in.
 */
function seasonWindow(now) {
      const today = now || new Date();
      const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const y = start.getUTCFullYear() + (start.getUTCMonth() >= 6 ? 1 : 0);
      return { start, end: new Date(Date.UTC(y, 5, 30)) };
}

/** ISO string for a day/month, with the year the season window implies. */
function dateInSeason(day, month, year, now) {
      if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
      const win = seasonWindow(now);
      const candidates = year
        ? [year < 100 ? 2000 + year : year]
        : [win.start.getUTCFullYear(), win.start.getUTCFullYear() + 1];
      for (const y of candidates) {
              const d = new Date(Date.UTC(y, month - 1, day));
              // Rejects 31 February and friends: the roll-over changes the month.
              if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue;
              if (year) return d.toISOString().slice(0, 10);
              if (d >= win.start && d <= win.end) return d.toISOString().slice(0, 10);
      }
      return null;
}

/**
 * Every date the message states, oldest first, as {day, month, year|null}.
 *
 * Numeric pairs are read day-first. That is not a coin toss: our customers are
 * European and write 26-02, and the two-figure pairs that would be ambiguous
 * (03-01) are resolved by the pair test below rather than by a guess.
 *
 * The lookarounds matter more than the pattern. Without them "1.98 m" reads as
 * a date, a phone number "06-42980629" reads as a date, and a shoe size "42.5"
 * reads as a date. Each of those appeared in real mail.
 */
// A number followed by one of these is a quantity, never a date.
const UNIT_AFTER = new RegExp(
      '^\\s*(?:' +
      'days?|nights?|hours?|weeks?|persons?|people|adults?|children|kids?|pax|' +
      'jours?|nuits?|heures?|semaines?|personnes?|adultes?|enfants?|' +
      'tage?n?|n[äa]chte?|stunden?|wochen?|personen|erwachsene|kinder|' +
      'dagen?|nachten|uur|weken|personen|volwassenen|kinderen|' +
      'giorni|notti|ore|settimane|persone|adulti|bambini|' +
      'd[ií]as?|noches|horas|semanas|personas|adultos|ni[ñn]os|' +
      'cm|kg|mm|km|eur|euros?|%' +
      ')\\b', 'i');

function findDateTokens(text) {
      const m = String(text || '');
      const out = [];

      // 1. ISO, unambiguous, wins wherever it appears.
      const iso = /(?<![\d/-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g;
      let x;
      while ((x = iso.exec(m))) {
              out.push({ at: x.index, to: x.index + x[0].length, day: +x[3], month: +x[2], year: +x[1] });
      }

      // 2. Numeric day/month, with an optional four-figure year. A two-figure
      //    tail is NOT read as a year: in "26-02 - 01-03" it would swallow the
      //    start of the second date.
      //    A full stop is also a decimal point, and that cost us #542168: a mail
      //    listing boot sizes "25.5", "23.5", "27.5" was read as three dates in
      //    May. So a dot-separated pair only counts as a date when it is written
      //    the way a date is written - a two-figure month (19.06) or the German
      //    trailing dot (26.2.) - which no shoe size ever is.
      const num = /(?<![\d.,])(\d{1,2})\s*([./-])\s*(\d{1,2})(\.?)(?:\s*[./-]\s*(20\d{2})|[./-](\d{2})(?![\d]))?(?![\d.,]*\d)/g;
      while ((x = num.exec(m))) {
              const a = +x[1], sep = x[2], bRaw = x[3], b = +bRaw, trailingDot = x[4] === '.';
              // Both readings impossible - a height, a size, a price.
              if (b > 31 || a > 31) continue;
              if (sep === '.' && bRaw.length < 2 && !trailingDot && !x[5] && !x[6]) continue;
              // "a 3-4 day training course (4-5 hours per day)" is a duration and
              // a headcount, not 3 April and 4 May. #512144 was quoted for a
              // month-long rental because of it. What follows the pair says
              // which it is.
              if (UNIT_AFTER.test(m.slice(x.index + x[0].length, x.index + x[0].length + 16))) continue;
              out.push({
                        at: x.index, to: x.index + x[0].length,
                        day: a, month: b, year: x[5] ? +x[5] : (x[6] ? 2000 + +x[6] : null),
                        swappable: a <= 12 && b <= 12,
              });
      }

      // 3. "26 February", "26th Feb", "1er mars", "26. Februar", "26 febbraio".
      const dayFirst = /(?<![\d.,])(\d{1,2})\s*(?:st|nd|rd|th|er|eme|ème|\.)?\s*(?:of\s+|de\s+|di\s+|del\s+)?([A-Za-zÀ-ɏ]{3,12})\.?/g;
      while ((x = dayFirst.exec(m))) {
              const mo = MONTH_WORDS[flat(x[2])];
              if (!mo) continue;
              const tail = m.slice(x.index + x[0].length, x.index + x[0].length + 7);
              const year = (tail.match(/^[\s,]*(\d{4})/) || [])[1];
              out.push({
                        at: x.index,
                        to: x.index + x[0].length + (year ? tail.indexOf(year) + 4 : 0),
                        day: +x[1], month: mo, year: year ? +year : null,
              });
      }

      // 4. "February 26", "Feb 26th" - the American order, common from UK and
      //    US customers and harmless to accept.
      const monthFirst = /([A-Za-zÀ-ɏ]{3,12})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?![\d.,]*\d)/g;
      while ((x = monthFirst.exec(m))) {
              const mo = MONTH_WORDS[flat(x[1])];
              if (!mo) continue;
              if (+x[2] > 31) continue;
              if (out.some(d => Math.abs(d.at - x.index) < 14)) continue;   // already read as day-first
              // "January 18, 2026" - the year sits after the comma, and without
              // reading it we dated a January 2026 accident to January 2027.
              const tail = m.slice(x.index + x[0].length, x.index + x[0].length + 7);
              const year = (tail.match(/^[\s,]*(\d{4})/) || [])[1];
              out.push({
                        at: x.index,
                        to: x.index + x[0].length + (year ? tail.indexOf(year) + 4 : 0),
                        day: +x[2], month: mo, year: year ? +year : null,
              });
      }

      out.sort((p, q) => p.at - q.at);
      return out;
}

/**
 * "du 9 au 14 mars" - two days, one month, and the commonest way a European
 * writes a week's holiday.
 *
 * Measured on 1809 real quote requests: 387 of them state their period exactly
 * once, in this shape, and the generic reader saw a single date because only
 * the second day carries a month. It is the largest single reason we fail to
 * price a mail that contains everything.
 *
 *   du 9 au 14 mars        vom 16. bis 18. Januar      dal 4 al 10 gennaio
 *   from 9 to 14 March     van 16 tot 18 januari       del 4 al 10 de marzo
 *
 * When the second day is the smaller of the two the holiday crosses a month
 * end - "du 28 au 3 janvier" is 28 December to 3 January - so the named month
 * belongs to the RETURN and the departure is the month before. Reading it the
 * other way round would move a Christmas rental to the following December.
 */
// Weekday names get written between the connector and the day far more often
// than you would guess - "du dimanche 9 jusqu'au samedi 15 février" - and a
// pattern that does not step over them reads that sentence as one date.
const WEEKDAY =
      '(?:mon|tues?|wed(?:nes)?|thurs?|fri|satur|sun)day|' +
      'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|' +
      'montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|' +
      'maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag|' +
      'luned[iì]|marted[iì]|mercoled[iì]|gioved[iì]|venerd[iì]|sabato|domenica|' +
      'lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo';

function findBareRange(text, now) {
      const found = [];
      const ORD = '(?:st|nd|rd|th|er|eme|[eè]me|\\.)?';
      const CONN = '(?:-|–|—|to|until|till|through|au|jusqu(?:\'|’)?(?:au|à|a)|bis(?:\\s+zum)?|' +
                   'tot(?:\\s+en\\s+met)?|t/m|al|fino\\s+al|hasta(?:\\s+el)?|a|and|et|und|en|e|y|/)';
      const FILL = '(?:\\s*(?:le|la|the|el|il|den|dem|de|op|on|il\\s+giorno)\\b)?' +
                   '(?:\\s*(?:' + WEEKDAY + ')\\b)?\\s*';
      const re = new RegExp(
        '(?:(?:' + WEEKDAY + ')\\s+)?' +
        '(?<![\\d.,])(\\d{1,2})\\s*' + ORD + '\\s*' + CONN + FILL +
        '(\\d{1,2})\\s*' + ORD + '\\s*(?:of\\s+|de\\s+|di\\s+|del\\s+|d[’\']|)\\s*' +
        '([A-Za-zÀ-ÿ]{3,12})\\.?' +
        '(?:\\s*,?\\s*(20\\d{2}|[2-4]\\d)\\b)?', 'gi');

      let x;
      while ((x = re.exec(String(text || '')))) {
              const month = MONTH_WORDS[flat(x[3])];
              if (!month) continue;
              const d1 = +x[1], d2 = +x[2];
              if (!(d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31)) continue;
              const year = x[4] ? +x[4] : null;
              // Same month, or the departure sits in the month before.
              const crosses = d2 < d1;
              const startMonth = crosses ? (month === 1 ? 12 : month - 1) : month;
              const startYear = year == null ? null : (crosses && month === 1 ? year - 1 : year);
              const s = dateInSeason(d1, startMonth, startYear, now);
              const e = dateInSeason(d2, month, year, now);
              if (!s || !e) continue;
              const days = (new Date(e) - new Date(s)) / 86400000;
              if (days < 0 || days > 31) continue;
              if (new Date(e) < seasonWindow(now).start) continue;
              found.push({ start_date: s, end_date: e, at: x.index });
      }

      // The same shape written entirely in figures: "für den 4.-11.1.",
      // "vom 25.12.-01.01." - the month rides on the second day only, exactly
      // as above, and German mail writes it this way constantly.
      const numeric = new RegExp(
        '(?<![\\d.,])(\\d{1,2})\\.?\\s*(?:-|–|—|bis(?:\\s+zum)?|au|to|till|until|tot|al|hasta|/)\\s*' +
        '(\\d{1,2})\\.(\\d{1,2})\\.?(?:\\s*(20\\d{2})|(\\d{2})(?![\\d]))?', 'g');
      while ((x = numeric.exec(String(text || '')))) {
              const d1 = +x[1], d2 = +x[2], month = +x[3];
              if (!(month >= 1 && month <= 12)) continue;
              if (!(d1 >= 1 && d1 <= 31 && d2 >= 1 && d2 <= 31)) continue;
              const year = x[4] ? +x[4] : (x[5] ? 2000 + +x[5] : null);
              const crosses = d2 < d1;
              const startMonth = crosses ? (month === 1 ? 12 : month - 1) : month;
              const startYear = year == null ? null : (crosses && month === 1 ? year - 1 : year);
              const s = dateInSeason(d1, startMonth, startYear, now);
              const e = dateInSeason(d2, month, year, now);
              if (!s || !e) continue;
              const days = (new Date(e) - new Date(s)) / 86400000;
              if (days < 0 || days > 31) continue;
              if (new Date(e) < seasonWindow(now).start) continue;
              found.push({ start_date: s, end_date: e, at: x.index });
      }

      /*
       * "la semaine du 28/12", "week of 17 February", "Woche vom 6.1."
       *
       * A week is a period, stated as precisely as any pair of dates - the
       * customer simply expects us to know that a week is seven days. Taking
       * the seventh day as the return is the reading they intend; if it is six
       * days they will say so, and the reply prints the dates back to them.
       */
      const week = new RegExp(
        '\\b(?:the\\s+week\\s+(?:of|beginning|starting|commencing)|semaine\\s+du|' +
        'woche\\s+vom|week\\s+van|settimana\\s+del|semana\\s+del)\\s+' +
        '(?:(?:' + WEEKDAY + ')\\s+)?(\\d{1,2})\\s*(?:st|nd|rd|th|er|\\.)?\\s*' +
        '(?:[./-]\\s*(\\d{1,2})|(?:of\\s+|de\\s+|di\\s+)?([A-Za-zÀ-ÿ]{3,12}))', 'i');
      const w = String(text || '').match(week);
      if (w) {
              const month = w[2] ? +w[2] : MONTH_WORDS[flat(w[3] || '')];
              const s = month ? dateInSeason(+w[1], month, null, now) : null;
              if (s) {
                        const e = new Date(new Date(s).getTime() + 7 * 86400000).toISOString().slice(0, 10);
                        if (new Date(e) >= seasonWindow(now).start) {
                                  found.push({ start_date: s, end_date: e, at: w.index });
                        }
              }
      }
      return found;
}

/**
 * The rental period, when the message states one.
 *
 * Two dates make a period; one alone does not, because it could be either end
 * and a guessed check-out is a wrong price. The pair has to make sense as a
 * ski holiday: in order, inside the bookable window, and no longer than a
 * month - which is what stops an invoice date or a birthday from being read as
 * a rental.
 */
/*
 * The stay and the rental are two different weeks, and the customer states
 * both.
 *
 * "Nous séjournons à Crest-Voland du 21 au 28 février et souhaiterions une
 * location de skis 6 jours (du dimanche 22/2 au vendredi 27/2)". Reading the
 * first period prices seven days instead of six, on the wrong days, and the
 * customer discovers it at the till. It is not a rare shape: people write
 * where they are staying before they write what they want to rent.
 *
 * So a period introduced by a renting word beats one introduced by a lodging
 * word. Everything else about the choice stays as it was.
 */
const RENTAL_CUE_NEAR = new RegExp(
      'lou(?:er|ons|é|e)|location|mat[eé]riel|devis|' +
      'rent(?:al|ing)?|hire|equipment|quote|offer|' +
      'mieten|miete|leihen|ausleihen|verleih|ausr[uü]stung|angebot|' +
      'huren|verhuur|uitrusting|offerte|' +
      'noleggi\\w*|attrezzatura|preventivo|' +
      'alquil\\w*|equipo|presupuesto', 'i');

const STAY_CUE_NEAR = new RegExp(
      's[ée]journ\\w*|logeons|logerons|h[ôo]tel|chalet|appartement|r[ée]sidence|' +
      'stay(?:ing)?|accommodation|lodge|apartment|' +
      '[uü]bernacht\\w*|unterkunft|wohnung|ferienwohnung|urlaub|' +
      'verblijf\\w*|verblijven|logeren|' +
      'soggiorn\\w*|alloggio|' +
      'alojam\\w*|hospedam\\w*', 'i');

function scorePeriod(text, at) {
      const before = String(text || '').slice(Math.max(0, at - 90), at);
      let score = 0;
      if (RENTAL_CUE_NEAR.test(before)) score += 2;
      if (STAY_CUE_NEAR.test(before)) score -= 2;
      return score;
}

function findPeriod(text, now) {
      // "du 9 au 14 mars" first: it is one unambiguous statement of a period,
      // and stronger evidence than any two dates that merely sit near each
      // other. Reading it here also rescues the 387 mails where it is the only
      // form the period is written in.
      const bare = findBareRange(text, now).map(c => Object.assign(c, { bare: true }));

      const tokens = findDateTokens(text);
      if (!bare.length && tokens.length < 2) return null;

      const tryPair = (a, b) => {
              const s = dateInSeason(a.day, a.month, a.year, now);
              const e = dateInSeason(b.day, b.month, b.year, now);
              if (!s || !e) return null;
              const days = (new Date(e) - new Date(s)) / 86400000;
              if (days < 0 || days > 31) return null;
              // Nobody asks to rent in the past. A period that has already ended
              // is a customer telling us about a previous holiday - #542686,
              // "I hired from you twice last year, 28th December 2024-4th
              // January 2025" - and reading it as a request is how a quote comes
              // out for a week that is over.
              if (new Date(e) < seasonWindow(now).start) return null;
              return { start_date: s, end_date: e };
      };

      const read = (a, b) => {
              const straight = tryPair(a, b);
              if (straight) return straight;
              // "03-01 - 09-01" written month-first by an English customer: both
              // halves are ambiguous, so try the other reading rather than lose
              // the period. Only when BOTH are swappable, and only if the
              // day-first reading produced nothing at all.
              if (a.swappable && b.swappable) {
                        return tryPair(
                          { day: a.month, month: a.day, year: a.year },
                          { day: b.month, month: b.day, year: b.year });
              }
              return null;
      };

      /*
       * Two dates in a mail are very often not the rental.
       *
       * #542387 said "J'ai effectué ce 24/01 une réservation ... du 22/02 au
       * 27/02". Taking the first two gave 24 January to 22 February - the day
       * she wrote to us, paired with the day her holiday starts. On a date
       * change that is not a near miss, it is a booking moved to the wrong
       * week.
       *
       * What separates a period from two dates that happen to be nearby is the
       * word between them: "to", "au", "bis", "tot", "al", "hasta", or a plain
       * dash. So a pair joined by one of those wins over a pair that is merely
       * adjacent, and only if no pair is joined at all do we fall back to
       * position.
       *
       * Among joined pairs the LAST one wins, which is what #542115 needs:
       * "instead of from 29 January to 1 February, I need them from the 28th to
       * the 31st" - the period the customer wants is the one they wrote second.
       */
      const JOINER = new RegExp(
        '^[\\s,)]*(?:-|–|—|\\+|>|to|until|till|through|thru|and|' +
        'au|jusqu(?:\'|’)?au|a|' +
        'bis|bis zum|bis einschliesslich|und|' +
        'tot|t/m|tot en met|en|' +
        'al|fino al|fino a|' +
        'hasta|hasta el|hasta al|' +
        'jusqu(?:\'|’)?a|jusque|ate|' +
        ')?[\\s,(]*$', 'i');

      const joined = [];
      for (let i = 0; i + 1 < tokens.length; i++) {
              const a = tokens[i], b = tokens[i + 1];
              if (b.at < (a.to || a.at)) continue;             // overlapping reads of one date
              // Weekday names and articles sit inside the joiner all the time -
              // "du dimanche 22/2 au vendredi 27/2" - and are noise for this
              // test, so they come out before it runs.
              const gap = String(text).slice(a.to || a.at, b.at)
                .replace(new RegExp('\\b(?:' + WEEKDAY + ')\\b', 'gi'), ' ')
                .replace(/\b(?:le|la|the|el|il|den|dem|op|on)\b/gi, ' ');
              if (gap.length > 34 || /\d/.test(gap)) continue;
              if (!JOINER.test(gap)) continue;
              const got = read(a, b);
              if (got) joined.push(Object.assign(got, { at: a.at }));
      }
      /*
       * All the well-formed candidates now compete, and the stay-versus-rental
       * cue decides. "Nous sejournons du 21 au 28 fevrier et souhaiterions une
       * location 6 jours (du 22/2 au 27/2)" offers both: the first is written
       * as a bare range, the second as a joined pair, and only the words in
       * front of each say which one is the rental.
       *
       * With nothing to separate them the bare range wins - it is the stronger
       * form - and between two of equal standing the last one wins, which is
       * what "instead of X, I need Y" requires.
       */
      const candidates = bare.concat(joined);
      if (candidates.length) {
              let best = null, bestKey = null;
              for (const cand of candidates) {
                        const key = [scorePeriod(text, cand.at), cand.bare ? 1 : 0, cand.at];
                        if (!bestKey || key[0] > bestKey[0] ||
                            (key[0] === bestKey[0] && key[1] > bestKey[1]) ||
                            (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] > bestKey[2])) {
                                  best = cand; bestKey = key;
                        }
              }
              return best;
      }

      // Nothing joined. Fall back to position, but not blindly: #542447 wrote
      // "am 19.06." in the subject and again in the first line, and two
      // mentions of one day fifty characters apart is a booking date said
      // twice, not a rental that starts and ends on the same morning. A real
      // single-day rental is written as a joined pair and was caught above.
      for (let i = 0; i + 1 < tokens.length; i++) {
              const a = tokens[i], b = tokens[i + 1];
              if (b.at < (a.to || a.at)) continue;
              const got = read(a, b);
              if (got && got.start_date === got.end_date) continue;
              if (got) return got;
      }
      return null;
}

// Number words, 1 to 12, in the six languages. Written out because "two
// adults" is far commoner in mail than "2 adults".
const NUM_WORDS = {
      one: 1, un: 1, une: 1, ein: 1, eine: 1, einen: 1, een: 1, uno: 1, una: 1,
      two: 2, deux: 2, zwei: 2, twee: 2, due: 2, dos: 2,
      three: 3, trois: 3, drei: 3, drie: 3, tre: 3, tres: 3,
      four: 4, quatre: 4, vier: 4, quattro: 4, cuatro: 4,
      five: 5, cinq: 5, funf: 5, fuenf: 5, vijf: 5, cinque: 5, cinco: 5,
      six: 6, sechs: 6, zes: 6, sei: 6, seis: 6,
      seven: 7, sept: 7, sieben: 7, zeven: 7, sette: 7, siete: 7,
      eight: 8, huit: 8, acht: 8, otto: 8, ocho: 8,
      nine: 9, neuf: 9, neun: 9, negen: 9, nove: 9, nueve: 9,
      ten: 10, dix: 10, zehn: 10, tien: 10, dieci: 10, diez: 10,
      eleven: 11, onze: 11, elf: 11, undici: 11, once: 11,
      twelve: 12, douze: 12, zwolf: 12, zwaalf: 12, twaalf: 12, dodici: 12, doce: 12,
};

const NUM_WORD_RE = Object.keys(NUM_WORDS).join('|');

/** A count written either way: "3", "three", "trois", "drei". */
function countAt(token) {
      const t = flat(token).trim();
      if (/^\d{1,3}$/.test(t)) return +t;
      return NUM_WORDS[t] || null;
}

const ADULT_WORDS = 'adults?|adultes?|erwachsene[nr]?|volwassenen?|adulti|adulto|adultos?';
const PERSON_WORDS = 'people|persons?|pax|skiers?|guests?|personnes?|personen|persone|personas|mensen|gente';
/**
 * Words that mean "a person under 18", in three tiers, because a flat list of
 * them is a false-positive machine.
 *
 * 582304 was the demonstration: Emma signed off "Kind regards", the German
 * word Kind was in the list, and a couple with no children was recorded as
 * mentioning one - which put the ages back into `needs` and blocked the very
 * quote this work exists to produce.
 *
 * So:
 *   CHILD_PLAIN     unambiguous in every language we read, matched anywhere.
 *   CHILD_CAPITAL   German nouns that are ordinary English words in lower
 *                   case. Matched only when capitalised, which is how German
 *                   writes them and English does not.
 *   CHILD_POSSESSED "son", "fille", "figlio" - each of them a common word in
 *                   some other language on this list ("son mari", "sei"), so
 *                   each needs a possessive in front to count.
 */
const CHILD_PLAIN =
      'children|kids?|teenagers?|toddlers?|infants?|' +
      'enfants?|gamins?|adolescents?|' +
      'kinder|kindern|jugendliche[rn]?|' +
      'kinderen|kindje|' +
      'bambini|bambino|bambina|ragazzi|ragazze|' +
      'ninos?|ninas?|chicos?|chicas?|' +
      'child|daughters?|dochters?|tochter';

const CHILD_CAPITAL = 'Kind|Kindes|Kinder|Kindern|Sohn|Tochter';

const POSSESSIVE =
      'my|our|his|her|their|mon|ma|mes|notre|nos|son|sa|ses|leur|leurs|' +
      'mein|meine|meinen|unser|unsere|unseren|ihr|ihre|sein|seine|' +
      'mijn|onze|zijn|haar|' +
      'mio|mia|miei|mie|nostro|nostra|nostri|nostre|suo|sua|' +
      'mi|mis|nuestro|nuestra|nuestros|nuestras|su|sus';

const CHILD_POSSESSED = 'sons?|fils|filles?|zoons?|hijos?|hijas?|figli|figlio|figlia';

const CHILD_WORDS = CHILD_PLAIN + '|(?:(?:' + POSSESSIVE + ')\\s+(?:' + CHILD_POSSESSED + '))';

/** Does this text talk about a child at all? */
function mentionsAChild(raw) {
      const m = flat(raw);
      if (new RegExp('\\b(?:' + CHILD_PLAIN + ')\\b', 'i').test(m)) return true;
      if (new RegExp('\\b(?:' + POSSESSIVE + ')\\s+(?:' + CHILD_POSSESSED + ')\\b', 'i').test(m)) return true;
      // German capitalisation is the only thing separating Kind from "Kind
      // regards", so this one test runs on the original text.
      // ... and "Kind regards" is not a child. It is how half of our English
      // mail ends, and it is what blocked 582304.
      if (new RegExp('\\b(?:' + CHILD_CAPITAL + ')\\b(?!\\s*(?:regards|regard|rgds))', 'i')
            .test(String(raw || '')) &&
          new RegExp('\\b(?:' + CHILD_CAPITAL + ')\\b(?!\\s*(?:regards|regard|rgds))')
            .test(String(raw || ''))) return true;
      return false;
}

/**
 * Where to look for an age, once we already know a child is in the message.
 *
 * Wider than the detector above on purpose: the capitalised German nouns and
 * the bare possessed nouns belong here, because at this point the question is
 * no longer "is there a child" but "where in the sentence is the number".
 */
const CHILD_SCAN = CHILD_PLAIN + '|' + CHILD_POSSESSED + '|' + flat(CHILD_CAPITAL);

/**
 * "Just the two of us" and everything that means the same in six languages.
 *
 * A pair phrase carries two facts at once: two adults, and - because the
 * sentence names the whole party - no children. Both are recorded, and the
 * second is the one that unblocks the quote. It is withdrawn later if a child
 * turns up anywhere else in the message.
 */
const PAIR_PHRASES = new RegExp(
      [
        // English
        '\\b(?:just |only )?(?:for |it(?:\'|’)?s |we are |we\'re )?(?:the |us )?two of us\\b',
        '\\b(?:me|myself) and my (?:husband|wife|partner|boyfriend|girlfriend|spouse)\\b',
        '\\bmy (?:husband|wife|partner|boyfriend|girlfriend|spouse) and (?:i|me|myself)\\b',
        '\\bfor (?:me and )?my (?:husband|wife|partner) (?:and (?:me|i|myself))?\\b',
        '\\bjust (?:the )?(?:two|2) of (?:us|them)\\b',
        '\\b(?:a )?couple\\b(?=[^.]{0,30}\\b(?:rent|ski|equipment|gear))',
        // French
        '\\bnous (?:sommes )?(?:que )?deux\\b', '\\b(?:a|pour) deux\\b', '\\bmon mari et moi\\b',
        '\\bma femme et moi\\b', '\\bmoi et mon mari\\b', '\\bmoi et ma femme\\b',
        '\\bmon (?:compagnon|conjoint|copain) et moi\\b', '\\bma (?:compagne|conjointe|copine) et moi\\b',
        '\\bnous deux\\b', '\\bjuste (?:nous )?deux\\b',
        // German
        '\\bzu zweit\\b', '\\bwir (?:sind )?zu zweit\\b',
        '\\bmein mann und ich\\b', '\\bmeine frau und ich\\b',
        '\\bmein (?:partner|freund) und ich\\b', '\\bmeine (?:partnerin|freundin) und ich\\b',
        '\\bnur (?:wir )?(?:zwei|beide)\\b', '\\bwir beide\\b',
        // Dutch
        '\\bmet (?:z\'n|zijn|ons) (?:tweeen|twee)\\b', '\\bmijn man en ik\\b', '\\bmijn vrouw en ik\\b',
        '\\bmijn (?:partner|vriend|vriendin) en ik\\b', '\\bwij (?:met )?(?:z\'n )?tweeen\\b',
        '\\balleen wij (?:tweeen|twee)\\b',
        // Italian
        '\\bnoi due\\b', '\\bin due\\b',
        '\\b(?:mio marito|mia moglie|il mio compagno|la mia compagna|il mio ragazzo|la mia ragazza) e(?:d)? io\\b',
        '\\bio e(?:d)? (?:mio marito|mia moglie|il mio compagno|la mia compagna|il mio ragazzo|la mia ragazza)\\b',
        '\\bsolo (?:noi )?(?:due|in due)\\b',
        // Spanish
        '\\bmi (?:marido|mujer|esposa|esposo|pareja|novio|novia) y yo\\b',
        '\\byo y mi (?:marido|mujer|esposa|esposo|pareja|novio|novia)\\b',
        '\\bnosotros dos\\b', '\\blos dos\\b', '\\bsolo (?:nosotros )?dos\\b',
        // The mirror image of every "X and I" above: "I and my wife" is not
        // elegant in any of these languages, and customers write it constantly.
        '\\b(?:i|ich|ik|moi|io|yo)\\s+(?:and|und|en|et|e|y)\\s+my\\b',
        '\\bich und (?:meine frau|mein mann|meine partnerin|mein partner)\\b',
        '\\bik en (?:mijn man|mijn vrouw|mijn partner)\\b',
        '\\bmoi et (?:mon mari|ma femme|mon compagnon|ma compagne)\\b',
        // The two halves of a couple with a clause between them: "louer des skis
        // pour mon mari et des chaussures pour moi" (#553869). Bounded to one
        // clause, because at any greater distance the two are not a pair.
        '\\b(?:mon mari|ma femme|my husband|my wife|my partner|mein mann|meine frau|' +
          'mijn man|mijn vrouw|mio marito|mia moglie|mi marido|mi mujer)\\b[^.!?]{0,45}?' +
          '\\b(?:moi|myself|ich|ik|io|yo)\\b',
      ].join('|'), 'i');

/** "Nobody under 18 is coming", said outright. */
const NO_CHILDREN = new RegExp(
      [
        'no (?:children|kids|child|minors)', 'without children', 'there are no children',
        'we have no (?:children|kids)', 'no (?:children|kids) (?:with us|in the group|are coming)',
        'child(?:ren)?:?\\s*(?:none|no|0)\\b', 'adults only',
        'pas d(?:\'|e )enfants?', 'sans enfants?', 'aucun enfant', 'que des adultes', 'uniquement des adultes',
        'keine kinder', 'ohne kinder', 'nur erwachsene',
        'geen kinderen', 'zonder kinderen', 'alleen volwassenen',
        'nessun bambino', 'senza bambini', 'niente bambini', 'solo adulti',
        'sin ninos', 'ningun nino', 'solo adultos',
      ].join('|'), 'i');

/**
 * How many adults, how many children and how old they are, from a sentence.
 *
 * Returns what it is sure of and nothing else. Three shapes are read, in
 * descending order of certainty:
 *
 *   1. counted outright        "2 adults and 1 child aged 9", "zwei Erwachsene"
 *   2. a party with a total    "we are 4, one is 7 years old"
 *   3. a pair phrase           "just for me and my husband"
 *
 * The ages are the delicate part. An age is only taken from a phrase that
 * names a child, so "she is 1.73 m" and "we booked 8 days" cannot become the
 * age of a child who does not exist.
 */
function findParty(text) {
      const raw = String(text || '');
      const m = flat(raw);
      const out = {};

      /*
       * "Adulte 1 : 75kg / 176cm — Adulte 2 : … — Enfant 1 : 31kg — Enfant 2 : …"
       *
       * A numbered list of people, one line each, with weight, height and shoe
       * size instead of an age. It is a common and very precise way to write a
       * party, and read naively it produces nonsense twice over: the index of
       * "Enfant 1" becomes a one-year-old, and the indices get counted as a
       * headcount. Here the labels are counted and the indices ignored, which
       * is what they are.
       */
      const ENUM_ADULT = /\b(?:adulte?s?|adult|erwachsene[rn]?|volwassene?|adulti|adulto|adultos?|persona|person|personne)\s*(?:n[°º]\s*)?\d{1,2}\s*[:\-–]/gi;
      const ENUM_CHILD = new RegExp('\\b(?:' + CHILD_PLAIN + ')\\s*(?:n[°º]\\s*)?\\d{1,2}\\s*[:\\-–]', 'gi');
      const enumAdults = (m.match(ENUM_ADULT) || []).length;
      const enumChildren = (m.match(ENUM_CHILD) || []).length;
      const enumerated = enumAdults + enumChildren >= 2;

      // --- children, first: an adult count is only safe once we know whether
      //     the message is talking about children at all.
      const mentionsChild = mentionsAChild(raw);

      const ages = [];
      if (mentionsChild) {
              // "aged 7 and 10", "de 7 et 10 ans", "7 und 10 Jahre", "di 7 e 10 anni",
              // "my son is 8", "kids (6, 9)". The age words anchor the numbers so a
              // shoe size or a height cannot drift in.
              // "12-jährigen Sohn" and "a 12-year-old" hyphenate the age onto the
              // cue, which is why the separator below is [\s-]* and not \s*.
              const AGE_CUE = '(?:aged?|age[sn]?|ans?|jahr\\w*|anni|annos?|anos?|jaar|jarige?|years?[\\s-]*old|year[\\s-]*old|yo|y\\.?o\\.?|old)';
              const JOIN = '(?:,|and|et|und|en|e|y|&|\\+|/)';
              const nearChild = [];
              const cre = new RegExp('(?:' + CHILD_SCAN + ')', 'gi');
              let c;
              while ((c = cre.exec(m))) {
                        nearChild.push(m.slice(Math.max(0, c.index - 40), c.index + 120));
              }
              for (const window of nearChild) {
                        // Both orders. "7 and 10 ans" puts the numbers before the
                        // cue, "aged 7 and 10" puts them after, and mail contains
                        // each about equally often.
                        const before = new RegExp('(\\d{1,2})[\\s-]*(?:' + JOIN + ')?[\\s-]*(?:(\\d{1,2})[\\s-]*)?(?:' + AGE_CUE + ')\\b', 'gi');
                        const after = new RegExp('\\b(?:' + AGE_CUE + ')\\s*:?\\s*(\\d{1,2})(?:\\s*(?:' + JOIN + ')\\s*(\\d{1,2}))?', 'gi');
                        for (const re of [before, after]) {
                                  let a;
                                  while ((a = re.exec(window))) {
                                            for (const g of [a[1], a[2]]) {
                                                      const v = g == null ? null : +g;
                                                      if (v != null && v >= 0 && v <= 17) ages.push(v);
                                            }
                                  }
                        }
                        // "children 6, 9 and 12" - a bare list right after the word.
                        const bare = window.match(new RegExp('(?:' + CHILD_SCAN + ')\\s*[:( ]\\s*((?:\\d{1,2}\\s*(?:,|and|et|und|en|e|y|&|\\+)?\\s*){1,6})', 'i'));
                        if (bare) {
                                  for (const g of bare[1].match(/\d{1,2}/g) || []) {
                                            const v = +g;
                                            if (v >= 0 && v <= 17) ages.push(v);
                                  }
                        }
              }
      }
      // An index in a numbered list is not an age.
      const uniqueAges = enumerated ? [] : [...new Set(ages)];
      if (uniqueAges.length) out.children_ages = uniqueAges.join(', ');
      else if (NO_CHILDREN.test(m)) out.children_ages = 'none';

      // A child named without an age is the one case that must still be asked.
      if (mentionsChild && !uniqueAges.length && out.children_ages !== 'none') {
              out._children_no_age = 'yes';
      }

      // --- adults
      if (enumerated) {
              if (enumAdults) out.adults = String(enumAdults);
              if (enumChildren) { out._children_no_age = 'yes'; delete out.children_ages; }
              else if (enumAdults) out.children_ages = 'none';
              return out;
      }

      const adultCount = m.match(new RegExp('\\b(\\d{1,3}|' + NUM_WORD_RE + ')\\s+(?:' + ADULT_WORDS + ')\\b', 'i'))
                      || m.match(new RegExp('(?:' + ADULT_WORDS + ')\\s*[:=]?\\s*(\\d{1,3})\\b', 'i'));
      if (adultCount) {
              const n = countAt(adultCount[1]);
              if (n != null && n >= 1 && n <= 60) out.adults = String(n);
      }

      if (!out.adults) {
              const people = m.match(new RegExp('\\b(?:we are|nous sommes|wir sind|wij zijn|siamo|somos|for|pour|fur|voor|per|para)?\\s*(\\d{1,3}|' + NUM_WORD_RE + ')\\s+(?:' + PERSON_WORDS + ')\\b', 'i'));
              if (people) {
                        const n = countAt(people[1]);
                        // A total is only an adult count once we know the children,
                        // and it is only usable when there are none.
                        if (n != null && n >= 1 && n <= 60 && out.children_ages === 'none') out.adults = String(n);
                        else if (n != null && n >= 1 && n <= 60 && uniqueAges.length && n > uniqueAges.length) {
                                  out.adults = String(n - uniqueAges.length);
                        }
              }
      }

      /*
       * A headcount with no word for "person" in sight.
       *
       * Measured on the same 1809: "we are" 137 times, "group" 49, and in
       * almost none of them does the number sit next to the word "adults". It
       * sits next to sets, pairs, packs, or nothing at all - "3 sets of skis",
       * "a group of 6 girls", "the 4 of us", "wir sind zu viert". One set of
       * equipment is one person, which is the whole reason a rental shop can
       * count this way.
       */
      if (!out.adults) {
              const UNITS = '(?:sets?|pairs?|paires?|paare?|paia|pares|packs?|complete? sets?|' +
                            'skisets?|equipments?|ausr[üu]stungen|uitrustingen)';
              const GEAR  = '(?:ski|skis|snowboard|snowboards|sci|esqu[ií]s?|schi|ausr[üu]stung|' +
                            'mat[ée]riel|attrezzatura|equipo|uitrusting)';
              const patterns = [
                // "3 sets of skis", "2 paires de skis", "4 x Ski"
                new RegExp('\\b(\\d{1,3}|' + NUM_WORD_RE + ')\\s+' + UNITS + '(?:\\s+(?:of|de|di|von|van)?\\s*' + GEAR + ')?\\b', 'i'),
                new RegExp('\\b(\\d{1,3})\\s*[x×]\\s*' + GEAR + '\\b', 'i'),
                // "a group of 6", "un groupe de 12", "eine Gruppe von 8"
                new RegExp('\\b(?:group|groupe|gruppe|groep|gruppo|grupo)\\s+(?:of|de|von|van|di)\\s+(\\d{1,3}|' + NUM_WORD_RE + ')\\b', 'i'),
                // "Nous sommes un groupe (14)" - the count in brackets right
                // after the word, which #532624 wrote and we read as one person.
                new RegExp('\\b(?:group|groupe|gruppe|groep|gruppo|grupo)\\s*\\(\\s*(\\d{1,3})\\s*\\)', 'i'),
                // "we are 5", "nous sommes 4", "wir sind 6", "siamo in 3"
                new RegExp('\\b(?:we are|there (?:are|will be)|nous sommes|nous serons|on est|wir sind|wir waren|' +
                           'wij zijn|we zijn|siamo(?: in)?|somos|seremos)\\s+(\\d{1,3}|' + NUM_WORD_RE + ')\\b', 'i'),
                // "the 4 of us", "(4 of us)", "à 5"
                new RegExp('\\b(\\d{1,3}|' + NUM_WORD_RE + ')\\s+of\\s+us\\b', 'i'),
              ];
              for (const re of patterns) {
                        const hit = m.match(re);
                        if (!hit) continue;
                        const n = countAt(hit[1]);
                        if (n == null || n < 1 || n > 60) continue;
                        // "un pack complet" is a count of one, and the weakest
                        // signal there is. When the same sentence also names a
                        // couple - "des skis pour mon mari et des chaussures pour
                        // moi ... un pack complet" (#553869) - the couple wins.
                        if (n === 1 && PAIR_PHRASES.test(m)) break;
                        // Everyone counted, minus the children we can name.
                        const kids = uniqueAges.length;
                        const grown = kids && n > kids ? n - kids : n;
                        if (kids && n <= kids) break;      // the count WAS the children
                        out.adults = String(grown);
                        break;
              }
              // "zu viert", "zu fünft" - German counts a party in one word.
              if (!out.adults) {
                        const ZU = { zweit: 2, dritt: 3, viert: 4, funft: 5, fuenft: 5, sechst: 6, siebt: 7, acht: 8 };
                        const z = m.match(/\bzu\s+(zweit|dritt|viert|funft|fuenft|sechst|siebt|acht)\b/i);
                        if (z) out.adults = String(ZU[flat(z[1])]);
              }
      }

      if (!out.adults && PAIR_PHRASES.test(m)) {
              out.adults = '2';
              // The phrase names the whole party. If a child is mentioned anywhere
              // else in the message the sentence was not exhaustive, so the claim
              // is dropped rather than trusted.
              if (!mentionsChild) out.children_ages = 'none';
      }

      return out;
}

/*
 * Our own quote form, filled in and sent back.
 *
 * We mail customers a template - SKIGEBIET / ERSTER MIETTAG / ANZAHL DER
 * PERSONEN - and 66 of the 1809 quote requests are that template returned with
 * every field completed. It is the most reliable message we ever receive, and
 * until now the extractor read it exactly as badly as free prose: a labelled
 * list of five things we need, and we asked for them again.
 *
 * Labels are matched, values are read to the end of the line. Nothing is
 * guessed: a field the customer left blank stays missing.
 */
const FORM_FIELDS = [
      ['resort_name',
       'ski\\s?(?:resort|gebiet|gebied|omr[åa]de|area)|station\\s+de\\s+ski|domaine\\s+skiable|' +
       'localit[àa]\\s+sciistica|zona\\s+de\\s+esqu[ií]|estaci[óo]n\\s+de\\s+esqu[ií]|skidestination'],
      ['shop_name',
       '(?:preferred|bevorzugtes|foretrukken|voorkeurs?)\\s*(?:shop|gesch[äa]ft|butik|winkel)|' +
       'magasin\\s+(?:pr[ée]f[ée]r[ée]|souhait[ée])|negozio\\s+preferito|tienda\\s+preferida'],
      ['start_date',
       'first\\s+(?:rental\\s+)?day|premier\\s+jour(?:\\s+de\\s+location)?|erster\\s+miettag|' +
       'eerste\\s+(?:huur)?dag|primo\\s+giorno\\s+di\\s+noleggio|primer\\s+d[ií]a\\s+de\\s+alquiler|' +
       'f[øo]rste\\s+lejedag|pick-?up\\s+date'],
      ['end_date',
       'last\\s+(?:rental\\s+)?day|dernier\\s+jour(?:\\s+de\\s+location)?|letzter\\s+miettag|' +
       'laatste\\s+(?:huur)?dag|ultimo\\s+giorno\\s+di\\s+noleggio|[úu]ltimo\\s+d[ií]a\\s+de\\s+alquiler|' +
       'sidste\\s+lejedag|return\\s+date'],
      ['_persons',
       'number\\s+of\\s+(?:people|persons|skiers)|nombre\\s+de\\s+personnes|anzahl\\s+der\\s+personen|' +
       'aantal\\s+personen|numero\\s+di\\s+persone|n[úu]mero\\s+de\\s+personas|antal\\s+personer'],
      ['_ages',
       'ages?\\s+and\\s+names?|names?\\s+and\\s+ages?|[âa]ge\\s+et\\s+nom|nom\\s+et\\s+[âa]ge|' +
       'alter\\s+und\\s+name|name\\s+und\\s+alter|leeftijd\\s+en\\s+naam|et[àa]\\s+e\\s+nome|' +
       'edad\\s+y\\s+nombre|alder\\s+og\\s+navn'],
      ['equipment_level',
       'equipment\\s+(?:needed|required)|mat[ée]riel\\s+(?:n[ée]cessaire|souhait[ée])|' +
       'ben[öo]tigte\\s+ausr[üu]stung|ausr[üu]stung\\s+f[üu]r\\s+jede|attrezzatura\\s+necessaria|' +
       'equipo\\s+necesario|benodigde\\s+uitrusting'],
];

function findFormFields(text, now) {
      const raw = String(text || '');
      const out = {};
      for (const [slot, labels] of FORM_FIELDS) {
              const re = new RegExp('^[^\\S\\n]*(?:[-*•]\\s*)?(?:' + labels + ')[^:\\n]{0,40}:\\s*([^\\n]{1,180})', 'im');
              const hit = raw.match(re);
              if (!hit) continue;
              const value = hit[1].trim().replace(/^[\s:–-]+/, '').trim();
              if (!value || /^\(?(?:si lo conosci|if you know|wenn bekannt|indien bekend)\)?$/i.test(value)) continue;
              out[slot] = value;
      }

      const clean = {};
      if (out.resort_name) clean.resort_name = out.resort_name.replace(/[.,;]+$/, '');
      if (out.shop_name && out.shop_name.length >= 3) clean.shop_name = out.shop_name.replace(/[.,;]+$/, '');
      for (const k of ['start_date', 'end_date']) {
              if (!out[k]) continue;
              const tok = findDateTokens(out[k])[0];
              const iso = tok ? dateInSeason(tok.day, tok.month, tok.year, now) : null;
              if (iso) clean[k] = iso;
      }
      // A period only counts when both ends are given: one alone is the same
      // ambiguity as anywhere else.
      if (!clean.start_date || !clean.end_date) { delete clean.start_date; delete clean.end_date; }

      // "ETÀ E NOME DI OGNI PERSONA: Maria Luisa 63 guido 65 diletta 10" - the
      // ages of everyone, from which the children separate themselves.
      if (out._ages) {
              const nums = (out._ages.match(/\b\d{1,2}\b/g) || []).map(Number).filter(n => n >= 0 && n < 100);
              if (nums.length) {
                        const kids = nums.filter(n => n < 18);
                        const grown = nums.filter(n => n >= 18);
                        if (grown.length) clean.adults = String(grown.length);
                        clean.children_ages = kids.length ? kids.join(', ') : 'none';
              }
      }
      if (!clean.adults && out._persons) {
              const n = countAt((out._persons.match(/\b\d{1,3}\b/) || [])[0] || out._persons);
              if (n != null && n >= 1 && n <= 60) clean.adults = String(n);
      }
      if (out.equipment_level && out.equipment_level.length >= 3) clean.equipment_level = out.equipment_level;
      return clean;
}

const SKI_WORDS = 'skis?|skiing|ski-?set|skier|skien|sci|esqui|esquis|schi';
const BOARD_WORDS = 'snowboards?|boarding|board|snowboarden|tavola|snow';
/*
 * Levels come in two kinds, and mixing them is what produced twenty-one
 * "advanced skiers" in a corpus of complaints and missing confirmations.
 *
 * Measured on the 314 mails of 26 January: "avance" fired nine times, all of
 * them on "à l'avance"; "confirme" seven times, every one of them the word
 * confirmation; "konnen" seven times, always the German verb; "profi" once,
 * inside "profil". Not one of the twenty-four was a skier's level.
 *
 * So the unambiguous words match anywhere, and the words that are ordinary
 * vocabulary in one of our six languages have to be introduced - by "niveau",
 * "level", "livello", or by naming a skier. A wrong level is a wrong price
 * tier, which is a wrong quote.
 */
const LEVEL_PLAIN = [
      ['beginner', '(?:beginners?|novices?|debutant(?:e|s|es)?|anf(?:a|ae)nger(?:in)?|einsteiger(?:in)?|' +
                    'principiant[eio]s?|novatos?|beginnend|first[\\s-]?time[rs]?)'],
      ['intermediate', '(?:intermediates?|intermediaires?|fortgeschritten(?:e|er)?|gevorderde?n?|' +
                       'intermedi[oa]s?)'],
      ['advanced', '(?:advanced|experts?|esperto|experto|avanzad[oa]s?|avanzat[oa]s?|ervarene?)'],
];

const LEVEL_CONTEXTUAL = [
      ['intermediate', '(?:moyen(?:ne)?s?|medi[oa]s?|mittel)'],
      ['advanced', '(?:avance(?:e|s|es)?|confirme(?:e|s|es)?|profis?|konner)'],
];

// What has to sit next to a contextual level word for it to count.
const LEVEL_CUE = '(?:niveau|niveaus|level|levels|livello|livelli|nivel|niveles|koennen|' +
                  'ski(?:er|eur|euse|fahrer|fahrerin)?s?|snowboarder?s?|rider|piste)';

/**
 * What they want to ride and how well they ride it.
 *
 * Kept as a sentence rather than a structure, because that is what the slot
 * declares and what the quote reads. The value is only produced when BOTH
 * halves are present: a message that says "skis" and nothing about level is
 * still missing the thing that sets the price tier, and must be asked.
 */
function findEquipmentLevel(text) {
      const m = flat(text);
      const kinds = [];
      if (new RegExp('\\b(?:' + SKI_WORDS + ')\\b', 'i').test(m)) kinds.push('skis');
      if (new RegExp('\\b(?:' + BOARD_WORDS + ')\\b', 'i').test(m)) kinds.push('snowboard');
      if (!kinds.length) return null;

      const levels = [];
      for (const [tier, pattern] of LEVEL_PLAIN) {
              if (new RegExp('\\b' + pattern + '\\b', 'i').test(m)) levels.push(tier);
      }
      for (const [tier, pattern] of LEVEL_CONTEXTUAL) {
              const near = new RegExp(
                '(?:' + LEVEL_CUE + ')[^.!?]{0,25}\\b' + pattern + '\\b' +
                '|\\b' + pattern + '\\b[^.!?]{0,25}(?:' + LEVEL_CUE + ')', 'i');
              if (near.test(m)) levels.push(tier);
      }
      if (!levels.length) return null;

      const order = ['beginner', 'intermediate', 'advanced'];
      const seen = order.filter(t => levels.includes(t));
      return kinds.join(' and ') + ', ' + seen.join(' and ');
}

/** Paid extras the customer named outright, in any of the six languages. */
function findExtras(text) {
      const m = flat(text);
      const out = {};
      const yes = w => new RegExp('\\b' + w + '\\b', 'i').test(m);
      const refused = w => new RegExp('\\b(?:no|not|without|pas de|sans|keine?|ohne|geen|zonder|nessun\\w*|senza|sin|ningun\\w*)\\s+(?:\\w+\\s+){0,2}' + w, 'i').test(m);

      const BOOTS = '(?:boots?|ski ?boots?|chaussures?|schuhe|skischuhe|schoenen|skischoenen|scarponi|botas)';
      const HELMET = '(?:helmets?|casques?|helme?|helmen|caschi|casco|cascos)';
      // Not "protection" and not "cover" on their own: both are ordinary
      // English and would put 15% on a quote because somebody asked us to cover
      // a cost.
      const INSUR = '(?:insurance|damage (?:and|&) theft|assurance|versicherung|verzekering|' +
                    'assicurazione|seguro|alpinguaranty|alpin ?guaranty|alpinflexi)';

      if (yes(BOOTS)) out.boots = refused(BOOTS) ? 'nobody' : 'everyone';
      if (yes(HELMET)) out.helmets = refused(HELMET) ? 'nobody' : 'everyone';
      if (yes(INSUR)) out.insurance = refused(INSUR) ? 'no' : 'yes';
      return out;
}

/**
 * Slots the message states outright.
 *
 * Caught on the first live call: "I want to cancel my booking B1AF9J" came back
 * as ASK / missing booking_ref, because slot values only ever came from the
 * caller's model. The flow would have asked the customer for the reference they
 * had just written. That is the same insult as asking someone to resend their
 * own message, and it is worse than not asking at all.
 *
 * Narrow where being wrong is expensive - a booking reference, a date, a
 * headcount - and silent everywhere else. Anything this function is not sure
 * of it leaves out, and the model's values still go through looksValid.
 */
function extractFromMessage(message, now) {
      const m = String(message || '');
      const found = {};

      // Odin references are 6 chars, upper case, and always carry a digit.
      // Requiring the digit keeps "PLEASE" and "CANCEL" out.
      // The real format, measured on 100 live Odin bookings (24/08/2026):
      // every one is exactly six characters, every one starts with B, and the
      // alphabet is 123456789ABCDEFGHJKLMNPQRSTUVWXYZ - no zero, no I, no O.
      // Someone chose an alphabet without look-alike characters.
      //
      // 26 of those 100 contain no digit at all. The old rule required one, so
      // it was blind to a quarter of all bookings - including BTRNLK, which is
      // why Alice's list of five looked like four on ticket 581695.
      //
      // Matching is case-SENSITIVE on purpose. Customers copy the reference out
      // of their confirmation email, so it arrives upper case; folding the whole
      // message to upper case first is what would turn the word "basket" into a
      // booking.
      const REF = /\bB[123456789ABCDEFGHJKLMNPQRSTUVWXYZ]{5}\b/g;
      // Six-letter upper-case words that happen to fit the alphabet. Rare in a
      // real message, free to exclude.
      const NOT_A_REF = ['BASKET','BUDGET','BEAUTY','BRANCH','BREATH','BREADS','BEHALF',
                         'BUCKET','BUNDLE','BRAKES','BLANKS','BEARER','BLAZER','BADGES'];
      const refs = [...new Set(m.match(REF) || [])].filter(t => !NOT_A_REF.includes(t));
      if (refs.length === 1) found.booking_ref = refs[0];
      // Several references is not "no reference".
      //
      // The old rule kept nothing unless exactly one matched, and on ticket
      // 581695 that turned a clear customer into a loop: Alice sent five
      // references and was asked for "your booking reference" three times, each
      // time answering with the same five. Silence read as absence, and the flow
      // asked again.
      //
      // Five bookings is not something a one-booking flow can do. Carrying the
      // list lets the handler say so and hand over, which is the honest answer.
      if (refs.length > 1) found._booking_refs = refs.join(', ');

      // Two dates in order are a period. One alone is ambiguous - it could be a
      // start or an end - so we take nothing. findPeriod reads ISO, day-month
      // and written-out months, and fills the year from the bookable season.
      const period = findPeriod(m, now);
      if (period) {
              found.start_date = period.start_date;
              found.end_date = period.end_date;
      }

      // Who is coming, and how old the children are when there are any.
      Object.assign(found, findParty(m));

      // Skis or a board, and the level - only when the message states both.
      const gear = findEquipmentLevel(m);
      if (gear) found.equipment_level = gear;

      // Boots, helmets and protection, named or refused outright.
      Object.assign(found, findExtras(m));

      // Our own form, last, so its labelled values overrule anything the prose
      // reader picked up from the same message: a field the customer filled in
      // under our label is the most explicit statement we ever get.
      Object.assign(found, findFormFields(m, now));

      return found;
}

function normaliseTopic(t) {
      const up = String(t || '').trim().toUpperCase();
      return TOPICS.includes(up) ? up : null;
}

/**
 * Slot values the caller extracted, kept only when they look like the thing
 * they claim to be. A model that returns "next week" for start_date is not
 * giving us a date, and letting it through is how a flow ends up writing a
 * booking to Odin for the wrong period.
 */
/**
 * Slots arrive in three shapes, and all three have to work.
 *
 * A Zendesk custom action builds its body with
 * evaluate_handlebar_expression_for_json_body, so a value that is itself JSON
 * either gets escaped or breaks the body outright - and which one it does is not
 * something to find out in production. So the flow sends the slots as plain
 * "key=value;key=value", which carries no quotes and no braces and therefore
 * cannot break anything. A JSON string and a real object are accepted too, for
 * callers that are not a Zendesk flow.
 */
function parseSlotBag(raw) {
      if (!raw) return {};
      if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
      const s = String(raw).trim();
      if (!s) return {};
      // The JSON does not have to be the whole string.
      //
      // This used to require s to START with "{", and a detector that answered
      // ```json\n{...}\n``` - or prefixed one polite sentence - fell through to
      // the key=value parser, matched nothing, and returned {}. Every slot then
      // read as missing, the flow's gate closed, and the ticket went silent with
      // no error anywhere: the model had extracted everything correctly and we
      // threw it away over a code fence.
      //
      // So take the first balanced object found anywhere in the string. A prompt
      // saying "no code fences" is a request, not a guarantee.
      const first = s.indexOf('{');
      const last = s.lastIndexOf('}');
      if (first !== -1 && last > first) {
              const slice = s.slice(first, last + 1);
              try { const o = JSON.parse(slice); if (o && typeof o === 'object' && !Array.isArray(o)) return o; } catch { /* fall through */ }
      }
      const out = {};
      for (const pair of s.split(';')) {
              const i = pair.indexOf('=');
              if (i <= 0) continue;
              out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      return out;
}

/**
 * Each capability flow names the same thing differently.
 *
 * Quote Generator's classifier emits preferred_resort_town, rental_start_date,
 * rental_end_date; the gatekeeper emits resort_name, start_date, end_date. Both
 * describe a resort and two dates. Rather than force every flow to be rewritten
 * to speak _slots.js, or worse, to add a translating custom-code step in front
 * of every call, the translation lives here - once.
 *
 * This is what lets a flow hand over its detector's raw JSON blob untouched:
 * Quote Generator already passes {{content}} straight to generate-quote, and it
 * can now pass the same blob to /api/intent.
 *
 * Aliases never win over the canonical name. A payload carrying both keeps the
 * canonical one, so adding a dialect can not change the meaning of a request
 * that was already correct.
 */
const SLOT_ALIASES = {
      resort_name:     ['preferred_resort_town', 'resort', 'resort_town', 'town'],
      shop_name:       ['shop', 'preferred_shop'],
      // new_start / new_end are Date Change's own names: its detector reports
      // the dates the customer wants to move TO, which is exactly what the
      // capability needs before it may run.
      start_date:      ['rental_start_date', 'startDate', 'start', 'new_start'],
      end_date:        ['rental_end_date', 'endDate', 'end', 'new_end'],
      booking_ref:     ['booking_reference', 'bookingReference', 'reference'],
      adults:          ['adult_count', 'nb_adults'],
      children_ages:   ['children', 'child_ages', 'kids_ages'],
      equipment_level: ['equipment', 'level', 'skill'],
      boots:           ['with_boots'],
      helmets:         ['helmet', 'with_helmets'],
      insurance:       ['protection', 'with_insurance', 'guaranty'],
};

function readSlot(src, name) {
      const candidates = [name].concat(SLOT_ALIASES[name] || []);
      for (const key of candidates) {
              const v = src[key];
              if (v === undefined || v === null) continue;
              const s = String(v).trim();
              if (s) return s;
      }
      return '';
}

function cleanSlots(raw) {
      const out = {};
      const src = parseSlotBag(raw);
      for (const name of Object.keys(SLOTS)) {
              const s = readSlot(src, name);
              if (!s) continue;
              out[name] = (name === 'booking_ref') ? s.toUpperCase() : s;
      }
      return out;
}

/**
 * The ticket is the memory.
 *
 * A flow sees one comment. That is why ticket 581704 asked Alice's colleague for
 * dates he had already narrowed down, and why on 581695 five booking references
 * were requested three times: each run started from nothing.
 *
 * Two ways to fix it were on the table. Writing what we learn into ticket fields
 * or an internal note gives a store that can silently disagree with what the
 * customer actually wrote - an agent clears a field, and the quote is built on a
 * memory of a conversation rather than the conversation. Reading the thread has
 * no such gap: the customer's own words are the store, and they cannot drift.
 *
 * Needs ZENDESK_SUBDOMAIN, ZENDESK_EMAIL and ZENDESK_API_TOKEN. With any of them
 * missing this returns null and everything behaves exactly as before - one
 * message, no history. Degrading to the old behaviour is the right failure: a
 * flow that stops working because a token expired would be worse than a flow
 * that briefly forgets.
 */
// Accept every shape of the same answer: "skisupport", "skisupport.zendesk.com",
// or the full "https://skisupport.zendesk.com/". Asking a human to remember which
// third of a URL a field wants is a trap, and it cost us one deploy: the value
// with the domain attached built skisupport.zendesk.com.zendesk.com, which does
// not resolve, and the failure surfaced only as "fetch failed".
const ZD_SUB = String(process.env.ZENDESK_SUBDOMAIN || '')
  .trim()
  .replace(/^https?:\/\//i, '')
  .replace(/\/.*$/, '')
  .replace(/\.zendesk\.com$/i, '');
const ZD_EMAIL = String(process.env.ZENDESK_EMAIL || '').trim();
const ZD_TOKEN = String(process.env.ZENDESK_API_TOKEN || '').trim();

function zdAuth() {
      if (!ZD_SUB || !ZD_EMAIL || !ZD_TOKEN) return null;
      return 'Basic ' + Buffer.from(ZD_EMAIL + '/token:' + ZD_TOKEN).toString('base64');
}

/**
 * Everything the customer has written on this ticket, oldest first.
 *
 * Our own replies are dropped on purpose. They quote the customer, they carry
 * our footer, and they contain the very questions we are trying to decide
 * whether to repeat - feeding them back in is how a bot ends up reading its own
 * words as evidence.
 */
/**
 * What the customer booked LAST TIME, read straight from Odin.
 *
 * "The same as last year" and "same specification as before" are among the most
 * common things a returning customer writes, and until now we answered them by
 * asking the questions the customer had just told us not to ask. On 581788 that
 * produced a question about children who do not exist - the previous booking was
 * two adults - and the customer had to explain themselves twice.
 *
 * Vercel CAN reach this route. The IP block that stops us calling Odin applies
 * to /webhook/*; GET /api/v2/booking/{ref} is public and requote-booking.js has
 * been calling it from Vercel for weeks. So the history lookup belongs here,
 * where every flow gets it for free, and not as a step in one flow.
 *
 * Returns a short prose summary, or '' - never throws, never blocks. A slow or
 * absent Odin costs us the history and nothing else, so the timeout is short and
 * every failure degrades to exactly the behaviour we had before.
 */
/**
 * "The same as last time."
 *
 * Detected on the customer's own words, never inferred. It is the one phrase
 * that licenses us to carry a previous booking's CHOICES into a new quote -
 * resort, discipline, level, who needs boots - because the customer has just
 * told us to. Dates are never carried: nobody means "the same week last year".
 *
 * Deliberately narrow. A customer who writes "I booked with you last year" is
 * giving context, not an instruction, and gets no prefill.
 */
const SAME_AS_BEFORE = new RegExp(
      '(same|identical|as)\\s+(as\\s+)?(last|previous|before|last\\s+year|last\\s+time)' +
      '|same\\s+(spec|specification|equipment|setup|kit|as\\s+before)' +
      '|(comme|identique\\s+a)\\s+(l.?an\\s+dernier|la\\s+derniere\\s+fois|avant|precedemment)' +
      '|meme\\s+(chose|equipement|materiel|configuration)\\s+(qu|que)' +
      '|(wie|dasselbe)\\s+(letztes\\s+jahr|beim\\s+letzten\\s+mal)',
      'i');

function saysSameAsBefore(text) {
      const t = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return SAME_AS_BEFORE.test(t);
}


/**
 * The resort the customer named without naming it.
 *
 * On 581828 the customer wrote the name of a lift and the name of a shop he did
 * NOT want, never the town. The extractor looked for a resort in the shape it
 * knows, found none, and asked a question whose answer was already on the page.
 * That is the same failure as 581704 and 581788 wearing a third disguise: the
 * information was there in a form we did not recognise.
 *
 * Adding another keyword pattern would only have covered the next case badly.
 * Our own shop table already carries the town of all 931 shops, so a shop name
 * anywhere in the thread resolves the town exactly - no guessing, no Odin call,
 * no new step in any flow.
 *
 * Deliberately conservative:
 *  - only distinctive words count. "Ski", "Sport", "Rental", "Verleih" and their
 *    friends appear in hundreds of shop names and would match everything.
 *  - a token must be at least 5 characters and match on a word boundary.
 *  - if two different towns match, we resolve NOTHING. An ambiguous guess about
 *    where someone is skiing is worse than a question.
 *
 * A shop the customer REFUSES still tells us the town - that is the whole point
 * of 581828, where "not the Cianross" was the only geographic fact in the mail.
 * So the town is taken and the shop is recorded as excluded, never proposed.
 */
const SHOPS_URL_FOR_PLACES =
  'https://raw.githubusercontent.com/benjasom-cyber/alpy-cart-api/main/api/shops_data.json';

const GENERIC_SHOP_WORDS = new Set([
  'ski', 'skis', 'skiing', 'sport', 'sports', 'sportshop', 'rental', 'rent',
  'rentals', 'verleih', 'skiverleih', 'noleggio', 'location', 'shop', 'store',
  'center', 'centre', 'point', 'service', 'salon', 'snow', 'board', 'snowboard',
  'intersport', 'sportservice', 'skirental', 'skiservice', 'sci', 'neige',
  'montagne', 'mountain', 'alpin', 'alpine', 'des', 'the', 'and', 'und',
]);

let _shopPlaces = null;

function deaccent(x) {
  return String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

let _shopTowns = null;
let _townSpelling = null;

async function loadShopPlaces() {
  if (_shopPlaces) return _shopPlaces;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(SHOPS_URL_FOR_PLACES, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return (_shopPlaces = []);
    const rows = await r.json();
    // A town's name is not a shop's identifier, even when a shop wears it.
    //
    // "Celso Sport Bormio 2000" contributed the token "bormio", so an Italian
    // customer writing "saremo a Bormio" - the town, plainly - was resolved to
    // the resort Bormio 2000, which is a different place up the mountain. The
    // token that names a town is dropped here; the town resolver below reads
    // it properly, and "Celso" still identifies the shop.
    const townWords = new Set();
    for (const row of (Array.isArray(rows) ? rows : [])) {
      for (const w of deaccent(row.town).split(/[^a-z0-9]+/)) if (w.length >= 4) townWords.add(w);
    }
    _shopPlaces = (Array.isArray(rows) ? rows : []).map(row => ({
      name: row.name,
      town: row.town,
      tokens: deaccent(row.name).split(/[^a-z0-9]+/)
        .filter(w => w.length >= 5 && !GENERIC_SHOP_WORDS.has(w) && !townWords.has(w)),
    })).filter(x => x.tokens.length);
    // The same rows also carry the town and its country, which is the only way
    // to know whether a big group is a FRENCH big group. Built here so the
    // large-group check below costs no second request.
    _shopTowns = new Map();
    _townSpelling = new Map();
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const t = deaccent(String(row.town || '')).trim();
      if (t.length >= 4 && !_shopTowns.has(t)) _shopTowns.set(t, String(row.country || '').toLowerCase());
      // The town as the table spells it, so a resolved resort goes back to the
      // customer as "Söll" and not "soll".
      if (t && !_townSpelling.has(t)) _townSpelling.set(t, String(row.town || '').trim());
    }
    return _shopPlaces;
  } catch {
    // No table, no resolution, and the flow behaves exactly as it did before.
    return (_shopPlaces = []);
  }
}

/** Was this mention a refusal? "not the X", "pas le X", "non ... X". */
function mentionIsRefused(hay, at) {
  const before = hay.slice(Math.max(0, at - 90), at);
  return /\b(not|no|nicht|kein|keine|pas|non|nessun|senza|other than|anything but|instead of)\b/i.test(before);
}

async function resolvePlaceFromShops(text) {
  const hay = deaccent(text);
  if (hay.length < 8) return null;
  const shops = await loadShopPlaces();
  const byTown = new Map();

  for (const shop of shops) {
    for (const tok of shop.tokens) {
      const at = hay.indexOf(tok);
      if (at < 0) continue;
      const before = at === 0 ? ' ' : hay.charAt(at - 1);
      const after = hay.charAt(at + tok.length) || ' ';
      if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) continue;
      const cur = byTown.get(shop.town) || { town: shop.town, shops: [], refused: [] };
      if (mentionIsRefused(hay, at)) {
        if (!cur.refused.includes(shop.name)) cur.refused.push(shop.name);
      } else if (!cur.shops.includes(shop.name)) {
        cur.shops.push(shop.name);
      }
      byTown.set(shop.town, cur);
      break;
    }
  }

  if (byTown.size !== 1) return null;   // nothing, or ambiguous - ask instead
  return byTown.values().next().value;
}

/**
 * The resort, when the customer names the resort rather than a shop.
 *
 * resolvePlaceFromShops above reads SHOP names, which is the right tool for
 * "not the Cianross" but blind to the far commoner case: the customer names
 * the town. On 582304 the town was written plainly - "Astenblick Apartment in
 * Winterberg, Germany" - and we asked her which resort she was going to.
 *
 * Matching a town list against free text is easy to get wrong in one specific
 * way: some of our towns are ordinary words in the languages we serve. Söll
 * deaccents to "soll", which is in every second German sentence; Vent is wind
 * in French; Stumm is an adjective. Three guards, cheap and sufficient:
 *
 *   - at least five characters, which drops Kals, Vars, Fiss, Oetz and the
 *     rest of the four-letter towns rather than risk them;
 *   - a short name must be capitalised where it appears, because a customer
 *     writing the resort writes Söll and a customer writing German writes
 *     soll;
 *   - two different towns resolve to nothing at all. A guess about where
 *     somebody is skiing is worse than a question.
 *
 * "Astenblick" is not in the list, "Germany" is not in the list, "Winterberg"
 * is - which is exactly the discrimination that was missing.
 */
// Towns whose name is an ordinary word somewhere in the six languages we read,
// even capitalised at the start of a sentence: Söll/soll and Vent/vent are the
// dangerous pair, and no capitalisation test saves them.
const TOWN_LOOKALIKES = new Set(['soll', 'stumm', 'lenk', 'bila', 'itter', 'vent', 'moena',
                                 'oetz', 'sant', 'sankt', 'saint', 'sainte', 'pejo', 'bad']);

async function resolveTownFromShops(text) {
  const raw = String(text || '');
  if (raw.length < 6) return null;
  await loadShopPlaces();
  if (!_shopTowns || !_shopTowns.size) return null;

  const hay = flat(raw);
  const hits = new Map();

  for (const town of _shopTowns.keys()) {
    // Four-letter resorts - Zürs, Vars, Fiss, Kals, Imst - were excluded
    // outright because "soll" and "vent" are ordinary words. Excluding them
    // costs real mail (13 quote requests in the archives named one), and the
    // capitalisation rule below already separates the resort from the verb:
    // a customer writing Zürs capitalises it, a customer writing German does
    // not. So they are allowed in, and lean entirely on that test.
    if (town.length < 4 || TOWN_LOOKALIKES.has(town)) continue;
    let at = hay.indexOf(town);
    while (at >= 0) {
      const before = at === 0 ? ' ' : hay.charAt(at - 1);
      const after = hay.charAt(at + town.length) || ' ';
      const wordBoundary = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
      // A short town has to look like a proper noun in the original text.
      const capitalised = /^[A-ZÀ-Þ]/.test(raw.charAt(at) || '');
      if (wordBoundary && (town.length >= 7 || capitalised) && !mentionIsRefused(hay, at)) {
        hits.set(town, at);
        break;
      }
      at = hay.indexOf(town, at + 1);
    }
  }

  if (hits.size !== 1) return null;
  const found = [...hits.keys()][0];
  // Give back the town as it is spelled in the shop table, not deaccented.
  return { town: originalTownSpelling(found) || found, shops: [], refused: [] };
}

function originalTownSpelling(flatName) {
  return (_townSpelling && _townSpelling.get(flatName)) || null;
}


/**
 * Mentioning two bookings is not the same as asking us to touch two bookings.
 *
 * The rule that sent every multi-reference message to a human was written for
 * ticket 581695. It was wrong for 581832, where the customer explained a
 * duplicate booking, quoted both references so we could tell them apart, and
 * then wrote: "Please kindly cancel the second booking under confirmation
 * BCGUA7". Counting references and stopping there threw away the sentence that
 * contained the instruction.
 *
 * So we count the bookings the customer asks us to ACT ON, not the ones they
 * name - and if they ask for three cancellations, that is three cancellations,
 * not a reason to fetch a human. "Our flows act on one booking at a time" was a
 * statement about our plumbing, never about their request; the Cancellation
 * Handler flow now loops over refs_to_cancel with a for_each step.
 *
 * The test is per sentence, and deliberately narrow, because the cost of being
 * wrong is cancelling the booking someone wanted to keep:
 *
 *  - a reference counts as a target only inside a sentence that also carries an
 *    action word;
 *  - a reference that never appears in such a sentence is context, never a
 *    target - that is what protects B91NDK on 581832;
 *  - nothing designated at all means we hand over exactly as before.
 *
 * "Please cancel B91NDK and BCGUA7" is therefore two targets, and both get
 * cancelled. That is what the customer wrote.
 */
const ACTION_CUE = new RegExp(
      'cancel|cancell|annul|annull|storn|disdet|refund|rembours|erstatt|rimbors' +
      '|delete|supprim|loschen|loeschen|revoke|withdraw|retir',
      'i');

// A sentence that announces a list: it ends on a colon, or it says "the
// following" in one of the languages we read. Required before we will look
// below the verb - see designatedRefs.
const LIST_INTRO = new RegExp(
      ':(?:\\s|&nbsp;?)*$' +
      '|following|suivant|folgend|seguent|siguient|volgend',
      'i');

function designatedRefs(text, refs) {
      if (!Array.isArray(refs) || !refs.length) return [];
      const raw = String(text || '');
      // Sentence-ish: line breaks and terminal punctuation. A reference and the
      // verb that governs it live in the same breath; across a paragraph break
      // they do not.
      const parts = raw.split(/[\n\r]+|(?<=[.!?])\s+/);
      const hits = new Set();

      // What is left of a line once the references, the mail client's padding
      // and any bullet or numbering are removed. Empty means the line was
      // nothing but references: "BRXV5Z", "- BGG114", "2. BRXV5Z&nbsp;".
      // "Merci de faire le necessaire" is not empty, and stops a list.
      const residue = (part) => {
              let t = String(part);
              for (const r of refs) t = t.split(r).join(' ');
              return t.replace(/&nbsp;?/gi, ' ')
                      .replace(/[\s\u00a0.,;:()\[\]{}<>|*#\/\-\u2013\u2014\u2022\u00b70-9]+/g, '')
                      .trim();
      };
      const holdsRef = (part) => refs.some(r => String(part).indexOf(r) > -1);
      const take = (part) => { for (const r of refs) if (String(part).indexOf(r) > -1) hits.add(r); };

      for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (!ACTION_CUE.test(part)) continue;
              take(part);

              // "Please cancel the two bookings below:" and then the references,
              // one per line. 581840 was written exactly like that and every
              // reference was thrown away, because the verb and the codes were
              // never in the same breath - a mail client had put them in
              // separate table cells.
              //
              // So we keep reading downwards - but only from a sentence that
              // opens a list, either by announcing one ("the following:") or by
              // already naming a reference the codes underneath carry on from. A
              // verb with neither marker nor reference is left alone: that stays
              // a handover, on purpose.
              //
              // The walk stops at the first line that is not purely references.
              // Prose ends a list, and a sentence that merely quotes a reference
              // is left to the per-sentence rule above - which is what still
              // protects the booking someone wanted to KEEP (581832).
              if (!LIST_INTRO.test(part) && !holdsRef(part)) continue;
              for (let j = i + 1; j < parts.length; j++) {
                        const next = parts[j];
                        const hasRef = holdsRef(next);
                        const rest = residue(next);
                        if (!hasRef && !rest) continue;   // blank line or padding
                        if (!hasRef) break;               // prose: the list is over
                        if (rest) break;                  // a sentence, not a list item
                        take(next);
              }
      }
      return [...hits];
}

const ODIN_BASE = 'https://odin.alpy.com';

/**
 * IS THIS BOOKING STILL ALIVE?
 *
 * 581920. The customer asked to move booking BAEGZF from 4 to 6 March. We asked
 * them, publicly, for their last day of rental. They answered. Only THEN did the
 * flow read Odin and discover the booking had been cancelled all along - and
 * ended on "an agent must handle this request". A wasted round trip, on a
 * customer who had told us everything the first time.
 *
 * The state of a booking is one HTTP read, it is authoritative, and it costs
 * nothing to do before we open our mouth. So a topic that acts on a booking now
 * checks it BEFORE the question goes out, and the question carries the news.
 *
 * Deliberately fail-soft: any error returns an empty verdict and the flow
 * behaves exactly as it did before. A slow Odin must never silence a reply.
 */
const BOOKING_STATE_CACHE = new Map();

async function fetchBookingState(ref) {
      const code = String(ref || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) return null;
      if (BOOKING_STATE_CACHE.has(code)) return BOOKING_STATE_CACHE.get(code);
      let out = null;
      try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 4000);
              const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(code),
                                    { headers: { Accept: 'application/json' }, signal: ctrl.signal });
              clearTimeout(t);
              if (r.status === 404) out = { found: false, status: '', cancelled: false, expired: false };
              else if (r.ok) {
                        const b = await r.json();
                        const st = String((b && (b.bookingStatus || b.status)) || '').toUpperCase();
                        out = {
                          found: true,
                          status: st,
                          cancelled: st.indexOf('CANCEL') > -1,
                          expired: st.indexOf('EXPIR') > -1,
                        };
              }
      } catch { out = null; }
      BOOKING_STATE_CACHE.set(code, out);
      return out;
}

async function fetchBookingHistory(ref) {
      const code = String(ref || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4,12}$/.test(code)) return '';

      let booking = null;
      try {
              const ctrl = new AbortController();
              const t = setTimeout(() => ctrl.abort(), 4000);
              const r = await fetch(ODIN_BASE + '/api/v2/booking/' + encodeURIComponent(code),
                                    { headers: { Accept: 'application/json' }, signal: ctrl.signal });
              clearTimeout(t);
              if (!r.ok) return '';
              booking = await r.json();
      } catch { return ''; }
      if (!booking || typeof booking !== 'object') return '';

      const day = v => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v || '')); return m ? m[1] : ''; };
      const from = day(booking.rentalPeriod && booking.rentalPeriod.from);
      const to   = day(booking.rentalPeriod && booking.rentalPeriod.to);

      // Age and equipment per person, plus who had boots and who had a helmet.
      // This is the part that answers "the same as before": it is the shape of
      // the group, not the price, that the customer is referring to.
      const people = [];
      let boots = 0, helmets = 0;
      for (const item of (booking.equipment || [])) {
              const age  = (item.personalInfo && parseInt(item.personalInfo.age, 10)) || null;
              const name = String(item.name || '').trim();
              const kind = /snowboard|board/i.test(name) ? 'snowboard' : 'ski';
              people.push((age ? age + 'yr' : 'adult') + ' ' + kind + (name ? ' (' + name + ')' : ''));
              for (const a of (item.accessories || [])) {
                        const an = String(a.name || '').toLowerCase();
                        if (a.definitionId === 1 || an.indexOf('boot') > -1) boots++;
                        if (a.definitionId === 2 || an.indexOf('helmet') > -1 || an.indexOf('casque') > -1) helmets++;
              }
      }
      if (!people.length) return '';

      const shop = (booking.shop && (booking.shop.name || booking.shop.town)) || '';
      const town = (booking.shop && booking.shop.town) || '';

      const bits = [];
      bits.push('Booking ' + code + ':');
      if (town) bits.push(' resort ' + town + (shop && shop !== town ? ' (' + shop + ')' : '') + ';');
      if (from && to) bits.push(' ' + from + ' to ' + to + ';');
      bits.push(' ' + people.length + ' person(s) - ' + people.join(', ') + ';');
      bits.push(' boots for ' + boots + ', helmets for ' + helmets + '.');
      return bits.join('');
}

async function fetchCustomerThread(ticketId) {
      // Why the memory is off is operational information, not debug output. A
      // silent null was enough to spend an afternoon guessing between "no token",
      // "wrong subdomain" and "the flow never sent a ticket id" - so the reason
      // travels back with the answer.
      const auth = zdAuth();
      if (!auth) {
              const missing = [
                        !ZD_SUB && 'ZENDESK_SUBDOMAIN',
                        !ZD_EMAIL && 'ZENDESK_EMAIL',
                        !ZD_TOKEN && 'ZENDESK_API_TOKEN',
              ].filter(Boolean);
              return { turns: [], count: 0, status: 'missing_env:' + missing.join(',') };
      }
      if (!ticketId) return { turns: [], count: 0, status: 'no_ticket_id' };

      try {
              const base = 'https://' + ZD_SUB + '.zendesk.com/api/v2/tickets/' + encodeURIComponent(ticketId);
              const headers = { Authorization: auth, Accept: 'application/json' };
              const [tRes, cRes] = await Promise.all([
                        fetch(base + '.json', { headers }),
                        fetch(base + '/comments.json?sort_order=asc', { headers }),
              ]);
              if (!tRes.ok || !cRes.ok) {
                        return { turns: [], count: 0, status: 'http_' + tRes.status + '_' + cRes.status };
              }

              const ticket = (await tRes.json()).ticket || {};
              const comments = (await cRes.json()).comments || [];
              const requester = ticket.requester_id;

              const mine = comments
                .filter(c => c && c.author_id === requester)
                .map(c => stripQuotedAndSignature(String(c.plain_body || c.body || '')))
                .filter(Boolean);

              // Has a human colleague already answered this customer in public?
              //
              // On 581718 an agent had done the whole job, the customer wrote
              // "Thanks a lot", and the automation answered that thank-you by
              // asking for a booking reference that had been on the ticket from
              // the first message. The customer had to be apologised to.
              //
              // So: once a person has replied in public, the automation is out.
              // Not "more careful" - out. A colleague who takes a ticket owns the
              // conversation, and a machine that talks over them costs more
              // credibility than it can ever earn back by being occasionally
              // right.
              //
              // Everyone who is not the requester and not us counts as that
              // person, minus the people Zendesk lets watch a ticket without
              // owning it - CCs, followers, collaborators - who would otherwise
              // read as agents. Our own comments are authored by Zendesk's
              // system user, whose id is negative.
              const watching = new Set([]
                        .concat(ticket.collaborator_ids || [])
                        .concat(ticket.follower_ids || [])
                        .concat(ticket.email_cc_ids || [])
                        .map(Number));
              const humanReply = comments.find(c => c && c.public &&
                        Number(c.author_id) > 0 &&
                        Number(c.author_id) !== Number(requester) &&
                        !watching.has(Number(c.author_id)));

              // The subject line is the customer's words too, and we were throwing
              // it away.
              //
              // Observed on 581658: the customer put "Val Thorens" in the subject
              // and wrote only "arriving in Val" in the body. We read the body,
              // saw "Val", and quoted a shop in Valmalenco, Italy. The one place
              // where the resort was written in full was the one place we never
              // looked.
              //
              // It is read as the OLDEST source, below every comment: a subject is
              // written once, at the start, and never updated, so anything the
              // customer says later must win. It is shown to the detectors at the
              // head of the transcript, where the resort is extracted. And it is
              // deliberately NOT a turn - it does not count towards turns_read or
              // the repeat-ask guard, because nobody "said" it twice.
              const subject = String(ticket.subject || '')
                .replace(/^\s*(re|fw|fwd|tr|aw|wg)\s*:\s*/gi, '')
                .trim();

              // The booking reference the "Last booking by email" flow found for us.
              //
              // That flow runs on ticket creation, searches Odin on the
              // requester's email and posts ONE internal note naming their most
              // recent booking. The note is authored by our system user, so the
              // requester-only filter above skips it - and the whole point of
              // finding the reference is lost the moment a customer writes "I
              // lost my voucher" without quoting a code.
              //
              // We read it back here, and it is a FALLBACK only: see
              // REF_FROM_HISTORY_IS_SAFE_FOR below for the topics allowed to act
              // on a reference the customer never typed.
              let knownRef = '';
              for (const c of comments) {
                        const body = String((c && (c.plain_body || c.body)) || '');
                        if (body.indexOf('SKIBOT - this customer has booked with us before') === -1) continue;
                        const m = body.match(/Most recent booking reference:\s*([A-Z0-9]{4,12})/);
                        if (m) knownRef = m[1];
              }

              return { turns: mine, text: mine.join('\n\n'), count: mine.length,
                       subject, knownRef,
                       agentReplied: !!humanReply,
                       agentRepliedAt: humanReply ? humanReply.created_at : null,
                       status: 'ok:' + comments.length + '_comments' +
                               (humanReply ? '_agent_answered' : '') };
      } catch (e) {
              // Name the host we tried. It is not a secret, and it is the
              // difference between "the token is wrong" and "the URL is wrong".
              return { turns: [], count: 0,
                       status: 'error:' + String((e && e.message) || e).slice(0, 40) +
                               ' host=' + ZD_SUB + '.zendesk.com' };
      }
}

/**
 * Keep what the customer typed; drop the mail furniture underneath it.
 *
 * Their reply carries our whole previous message quoted below theirs, plus their
 * own signature. Left in, our footer's "bd@alpy.com" once made a customer look
 * like a colleague, and our own question about children's ages could be mistaken
 * for their answer.
 */
function stripQuotedAndSignature(body) {
      let t = body.replace(/\r/g, '');
      const cuts = [
              /^\s*-{2,}\s*$/m,                       // -- signature delimiter
              /^\s*_{5,}\s*$/m,
              /^\s*>/m,                               // quoted block
              /^\s*(On|Le|Am|El)\b.{0,80}\b(wrote|a [eé]crit|schrieb|escribi[oó])\s*:/mi,
              /^\s*(De|From|Von|Da)\s*:/mi,
              // The same header, but NOT at the start of a line.
              //
              // 581870: the customer forwarded our own confirmation email, and her
              // mail client flattened it onto one line - "... Nadine Le Goupil. De :
              // Alpy.com <web@alpy.com> Envoye : lundi 31 aout". The anchored rule
              // above never matched, so the quoted confirmation stayed in the text,
              // and the word "annuler" IN OUR OWN EMAIL turned a date-change request
              // into a cancellation. Measured: the same message without the quote is
              // not a cancellation; with it, it is.
              //
              // The signal has to be strong enough to never cut a customer's own
              // sentence, so the header must be followed by an address or by the
              // next header of a forwarded block.
              /\b(De|From|Von|Da)\s*:\s*[^\n]{0,80}?[<(]?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/i,
              /\b(Envoy[eé]|Sent|Gesendet|Inviato|Enviado)\s*:\s*\w/i,
              /\b(Objet|Subject|Betreff|Oggetto|Asunto)\s*:\s*[^\n]{0,80}\b(confirmation|booking|r[eé]servation|voucher)\b/i,
              // THE VERB AND THE COLON ARE NOT ALWAYS ADJACENT (10 septembre 2026).
              //
              // The rule above wants "schrieb:" - but German, Dutch and Danish mail
              // clients put the sender in between: "Am 14.12.2025 um 21:29 schrieb
              // Alpy.com <web@alpy.com>:", "Op ma 26 jan 2026 schreef Alpy.com
              // <web@alpy.com>:". "schreef", "ha scritto", "skrev" and "napisal"
              // were not in the verb list at all. Measured on the 314 mails of 26
              // January: on six of the nine mails that Voucher Resend refused, the
              // cut removed NOTHING, our whole quoted confirmation stayed in the
              // text, and its words - Rechnung, Versicherung, payment - matched the
              // "documents + payment" voucher rule. The customers were asking to
              // cancel after an injury, to remove four people from a booking, to add
              // a missing insurance. None of them wanted a voucher.
              /^\s*(On|Le|Am|El|Op|Il|Den|W\s?dniu)\b[^\n]{0,140}?\b(wrote|a [eé]crit|schrieb|schreef|escribi[oó]|ha scritto|skrev|napisa[lł]\w*)\b[^\n]{0,120}?:/mi,
              // The opening line of a forwarded block, one per language.
              /^\s*(Start p[åa] videresendt besked|Inizio messaggio inoltrato|Begin doorgestuurd bericht|Anfang der weitergeleiteten Nachricht|D[ée]but du message transf[ée]r[ée]|Begin forwarded message|-{5,}\s*Forwarded message)/mi,
              // A phone signature always sits immediately above the quote.
              /^\s*(Von meinem iPhone gesendet|Sent from my iPhone|Sent from my Samsung|Envoy[eé] de mon iPhone|Verzonden vanaf mijn iPhone|Inviato da iPhone|Sendt fra min iPhone)\b/mi,
              // Our own confirmation, quoted: its first line is the booking number.
              /^\s*(Ihre Buchungsnummer|Your booking reference|Votre num[ée]ro de r[ée]servation|Din reservationsnummer|Il tuo numero di prenotazione|Uw boekingsnummer|Numer rezerwacji)\s*:/mi,
              /The information transmitted in this e-?mail/i,
              /Powered\s*by\s*2beGROUP/i,
              /Head of Support/i,
      ];
      for (const re of cuts) {
              const m = t.match(re);
              if (m && m.index > 0) t = t.slice(0, m.index);
      }
      return t.trim();
}

/**
 * What we can answer without a human, and without inventing anything.
 *
 * Every line here is checked against the live catalogue or the shop data - the
 * 15% is the insurance addon's priceRelative on core.alpy.com, measured, not
 * remembered. When a customer asks something outside this list we say nothing
 * rather than improvise: a wrong answer about cover is worse than a slow one.
 */
// Le meme code que celui applique par generate-quote.js, lu de la meme variable
// pour qu'un changement ne soit a faire qu'une fois. Annoncer un code perime est
// pire que ne pas en annoncer.
const ACTIVE_PROMO_CODE = process.env.ALPY_PROMO_CODE || 'SKI26';

const PRODUCT_ANSWERS = [
      // TICKET 581889. A un client qui demandait "avez-vous un code pour l'an
      // prochain ?", la reponse composee a ete : "I'm afraid that isn't
      // something we are able to advise on here". C'est faux - nous avons un
      // code, il est deja applique a chaque panier - et c'est une phrase
      // negative posee au moment precis ou le client est pret a reserver.
      //
      // Le modele n'avait aucun fait sur le sujet : sans fait, il se replie sur
      // une formule d'evitement. Le fait ci-dessous supprime la cause.
      {
              key: 'promo_code',
              re: /\b(promo(?:tion)?\s*code|code\s+promo|discount\s+code|voucher\s+code|rabatt\s?code|gutschein\s?code|codice\s+sconto|c[oó]digo\s+(?:de\s+)?descuento)\b|\b(discount|r[eé]duction|remise|rabatt|sconto|descuento)\b[\s\S]{0,30}\b(code|coupon)\b/i,
              fact: 'Yes, we have a promotion code running: ' + ACTIVE_PROMO_CODE + '. It is applied automatically to every quote we build, so the price shown in the cart link is already the discounted price. Say the code is included in the quote being prepared - never say that discounts cannot be advised on. From eight people a group voucher applies on top, calculated in the quote itself: state that it applies, never a figure.',
      },
      {
              key: 'insurance',
              re: /\b(alpin\s*guaranty|alpinguaranty|guaranty|assurance|insurance|protection|casse\s*(et|&)?\s*vol|dommages?\s*(et|&)?\s*(le\s*)?vol|damage\s*(and|&)?\s*theft|versicherung|seguro|assicurazione)\b/i,
              fact: 'Damage & theft protection (sold as AlpinGuaranty) costs 15% of the rental price and covers breakage and theft of the equipment we rent out. It is optional, it is added per person, and it is never included unless the customer asks for it.',
      },
      {
              key: 'boots',
              re: /\b(boots?|chaussures?|schuhe|scarponi|botas)\b/i,
              fact: 'Boots are an optional extra, priced per person and per day. Anyone bringing their own does not pay for them.',
      },
      {
              key: 'helmets',
              re: /\b(helmets?|casques?|helm|casco|kask)\b/i,
              fact: 'Helmets are an optional extra, priced per person and per day. Nobody is obliged to take one.',
      },
      {
              key: 'children',
              re: /\b(child|children|kid|kids|enfant|enfants|kinder|ni[nñ]os|bambini)\b.{0,40}\b(price|pricing|cost|tarif|prix|preis|precio)\b|\b(price|pricing|tarif|prix)\b.{0,40}\b(child|children|enfant|kinder)\b/i,
              fact: 'Children are priced on their exact age, and the age bands differ from shop to shop. That is why a quote cannot be produced without every child\'s age.',
      },
];

/**
 * A question, not an answer.
 *
 * On 581704 the customer replied to our list of questions with "que couvre la
 * protection alpinguaranty ?" - and got silence, because the reply did not
 * contain the slots we wanted. A question deserves its answer even when it
 * arrives instead of the information we asked for.
 */
function buildTranscript(turns, subject, knownRef, history) {
      if (!turns || !turns.length) return '';
      const numbered = turns.map((t, i) => 'Customer, message ' + (i + 1) + ' of ' + turns.length + ':\n' + t);
      let out = numbered.join('\n\n');
      // The subject line, at the head, labelled for what it is.
      //
      // 581658: "Val Thorens" was in the subject and only "Val" in the body. The
      // detector never saw the subject, resolved "Val" on its own, and we quoted
      // Valmalenco - a different country. A customer who names the resort once,
      // in the title, has named it.
      //
      // It sits ABOVE the messages and outside the numbering: it is context, not
      // a turn, and a detector must not count it as something the customer said
      // twice.
      if (subject) out = 'Email subject: ' + subject + '\n\n' + out;

      // The reference we found on their email, labelled for exactly what it is.
      //
      // A detector reading this transcript must be able to use the code AND to
      // know the customer never typed it - those are different facts and a bare
      // reference in the text would collapse them into one. Hence the wording:
      // it says where the code came from, in the same breath as the code.
      // What they booked last time, above everything else: it is the answer to
      // "the same as before", and a detector that reads it can stop asking.
      if (history) {
              out = 'WHAT THIS CUSTOMER BOOKED LAST TIME (from our records, not ' +
                    'stated by them now): ' + history + '\nUse it to understand ' +
                    '"the same as before". Never reuse the dates - those are always new.\n\n' + out;
      }

      if (knownRef) {
              out = 'Known from our records (NOT stated by the customer): this ' +
                    'customer\'s most recent booking with us is ' + knownRef +
                    '. Use it only where acting on the wrong booking would be ' +
                    'harmless.\n\n' + out;
      }
      if (out.length > 8000) out = '[…earlier messages omitted…]\n\n' + out.slice(out.length - 8000);
      // The date travels INSIDE the transcript, not beside it.
      //
      // `today` is returned as its own field too, but a detector prompt can only
      // reference a field the Zendesk custom action declares in its response
      // schema - and that schema was captured before `today` existed. Every
      // prompt pointing at it showed "Variable is no longer available", which
      // made the step invalid, which made the whole flow refuse to save. The
      // schema still lists only action, agentnote, answers, missinglabels,
      // next_question, run_topic, topic and transcript.
      //
      // So the date rides on `transcript`, a leaf that has always been declared.
      // Every detector gets it with no schema surgery and no per-flow wiring.
      return 'Today is ' + new Date().toISOString().slice(0, 10) +
             '. Resolve every relative or year-less date against it, and never ' +
             'output a date in the past.\n\n' + out;
}

/**
 * Is this message nothing but a thank-you or a goodbye?
 *
 * A closing courtesy is not a request. It carries no topic, no slot and no
 * question - answering it can only produce noise, and on 581718 it produced an
 * apology.
 *
 * Deliberately strict: the message must be SHORT and contain nothing but
 * pleasantries. "Thanks, and could you also move the dates?" is a request and
 * must fall through to the normal path. When in doubt this returns false, which
 * costs a handover at worst - the safe direction.
 */
const GRATITUDE_ONLY = new RegExp(
      '^(?:' +
      'thanks?(?:\\s+(?:a\\s+lot|very\\s+much|so\\s+much|again))?|thank\\s+you(?:\\s+very\\s+much)?|' +
      'many\\s+thanks|much\\s+appreciated|appreciate\\s+it|' +
      'perfect|great|super|excellent|brilliant|lovely|noted|understood|ok(?:ay)?|received|' +
      'merci(?:\\s+(?:beaucoup|bien|d\\W?avance))?|je\\s+vous\\s+remercie|parfait|tr[eè]s\\s+bien|' +
      'danke(?:\\s+(?:sch[oö]n|dir|ihnen|vielmals))?|vielen\\s+dank|besten\\s+dank|alles\\s+klar|' +
      'grazie|gracias|bedankt|tack|' +
      'best\\s+regards|kind\\s+regards|regards|cheers|bye|goodbye|have\\s+a\\s+nice\\s+day|' +
      'cordialement|bien\\s+[aà]\\s+vous|salutations|bonne\\s+journ[eé]e|' +
      'mit\\s+freundlichen\\s+gr[uü]ssen|freundliche\\s+gr[uü]sse|sch[oö]nen\\s+tag|' +
      'hi|hello|hey|dear\\s+\\w+|bonjour|hallo|guten\\s+tag' +
      ')$', 'i');

function isCourtesyOnly(message) {
      const body = stripQuotedAndSignature(String(message || ''));
      // A thank-you is short. Anything long enough to hide a request is treated
      // as one.
      if (!body || body.length > 240) return false;
      if (/\?/.test(body)) return false;

      // Split on anything that separates a courtesy from the next one, then
      // require every remaining fragment to be a courtesy.
      const parts = body
        .split(/[\n\r,;.!]+/)
        .map(p => p.replace(/^[\s"\u2018\u2019\u201c\u201d]+|[\s"\u2018\u2019\u201c\u201d]+$/g, ''))
        .filter(p => p.length > 0);
      if (!parts.length) return false;
      if (parts.every(p => GRATITUDE_ONLY.test(p))) return true;

      // A signature that survived the stripper is not a request. "Thanks a lot.
      // Regards, Yuriy Mykhaylyshchuk" is a thank-you, and it is the exact shape
      // 581718 arrived in.
      //
      // Only the LAST fragment may be a bare name, and only when everything
      // before it was courtesy - so "Please cancel Booking" cannot slip through
      // on capitalisation alone.
      const last = parts[parts.length - 1];
      const head = parts.slice(0, -1);
      const looksLikeAName = /^(?:[A-Z\u00C0-\u00DE][A-Za-z\u00C0-\u024F'\u2019-]*)(?:\s+[A-Z\u00C0-\u00DE][A-Za-z\u00C0-\u024F'\u2019-]*){0,3}$/.test(last);
      return head.length > 0 && looksLikeAName &&
             head.every(p => GRATITUDE_ONLY.test(p));
}

function detectProductQuestion(message) {
      const m = String(message || '');
      if (!/\?|\bque\s+couvre\b|\bwhat\s+(is|does|are)\b|\bqu(\'|e\s)est[- ]ce\b|\bwas\s+ist\b/i.test(m)) return [];
      return PRODUCT_ANSWERS.filter(a => a.re.test(m)).map(a => ({ topic: a.key, fact: a.fact }));
}

/**
 * You may not ask someone to buy something you have not described.
 *
 * The slot named "damage & theft protection" reached the composing prompt as
 * that label and nothing else, so the message that came out asked the customer
 * whether they wanted an option it had never explained - and, having no facts to
 * work with, the model filled the hole by promising that "another team" would
 * answer about it, then asked anyway. Deflection and interrogation in the same
 * paragraph.
 *
 * The label alone was never enough. Whenever we ask for one of these, the fact
 * that describes it travels with the question: what it is, what it costs, that
 * it is optional. The customer can then actually answer.
 *
 * children_ages carries its own reason for the same reason - "how old is each
 * child" with no explanation reads as bureaucracy rather than pricing.
 */
const SLOT_FACTS = {
      insurance:     'insurance',
      boots:         'boots',
      helmets:       'helmets',
      children_ages: 'children',
};

// A slot counts as stated when it carries any non-empty value, including an
// explicit refusal. "No one needs insurance" is an answer, not a gap.
function hasSlot(slots, name) {
      const v = slots && slots[name];
      return v !== undefined && v !== null && String(v).trim() !== '';
}

function factsForMissing(missing) {
      const out = [];
      for (const requirement of (missing || [])) {
              for (const name of String(requirement).split('|')) {
                        const key = SLOT_FACTS[name];
                        if (!key) continue;
                        const entry = PRODUCT_ANSWERS.find(a => a.key === key);
                        if (entry) out.push({ topic: entry.key, fact: entry.fact });
              }
      }
      return out;
}

// A fact the customer asked for and a fact we owe them because we are about to
// ask for the slot are the same sentence; saying it twice is worse than saying
// it once.
function mergeFacts(asked, owed) {
      const seen = new Set();
      const out = [];
      for (const f of asked.concat(owed)) {
              if (seen.has(f.topic)) continue;
              seen.add(f.topic);
              out.push(f);
      }
      return out;
}

export default async function handler(req, res) {
      Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
      if (req.method === 'OPTIONS') return res.status(200).end();

      let params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
      if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = {}; } }
      if (!params || typeof params !== 'object' || Array.isArray(params)) params = {};

      const message = params.message ?? params.comment ?? '';
      const tags = params.tags ?? [];
      const llmTopic = normaliseTopic(params.llm_topic ?? params.llmtopic ?? params.topic);

      // Who wrote this. The flow passes the requester's email; when it is absent
      // we simply do not apply the internal-sender rule, rather than falling
      // back to scanning the body - that fallback is what silenced 581697.
      const senderEmail = params.sender_email ?? params.senderemail
                        ?? params.requester_email ?? params.requesteremail ?? '';

      // The topic this ticket was already waiting on, carried by the flow as an
      // awaiting__<topic> tag.
      //
      // Without it the second turn of every conversation collapses: we ask "what
      // is your booking reference", the customer replies "B1AF9J", and a message
      // of six characters matches no keyword and carries no topic - so the flow
      // that just asked the question forgets it ever did. The customer answered
      // exactly what was asked and lands on a human anyway.
      //
      // It ranks below the tag and keyword layers (a customer who was asked about
      // a cancellation may well change the subject) but above the model, because a
      // question we asked one message ago is better evidence than a guess.
      const pendingTopic = normaliseTopic(
              params.pending_topic ?? params.pendingtopic ??
              (function () {
                        const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
                        const hit = list.map(t => String(t || '').trim())
                          .find(t => /^awaiting__/.test(t));
                        return hit ? hit.replace(/^awaiting__/, '') : null;
              })()
      );
      // A quote we OFFERED is not a question we ASKED. Different tag, on purpose.
      //
      // General questions and Shop services both end by offering to prepare a
      // quote. When the customer replies "oui avec plaisir", that reply matches
      // no keyword and carries no topic, so without a marker it lands on OTHER
      // and a human reads a message that says yes to something we proposed.
      //
      // Reusing awaiting__quote would have routed it - and then tripped the
      // anti-loop rule below, which reads awaiting__ as "we already asked for
      // these details and they still are not here" and hands over. We never
      // asked. So the offer carries its own tag, it feeds the topic decision
      // exactly like a pending topic, and it is deliberately absent from
      // alreadyAsked: the first real question about the rental has yet to be
      // put, and putting it is the whole point.
      const offeredTopic = normaliseTopic(
              params.offered_topic ?? params.offeredtopic ??
              (function () {
                        const list = Array.isArray(tags) ? tags : String(tags || '').split(/[,\s]+/);
                        const hit = list.map(t => String(t || '').trim())
                          .find(t => /^offered__/.test(t));
                        return hit ? hit.replace(/^offered__/, '') : null;
              })()
      );
      // What the message says outright wins over what the model reported: the
      // customer's own words are the better source, and a model that paraphrases
      // a reference gets it wrong.
      const ticketId = params.ticket_id ?? params.ticketid ?? params.ticket ?? '';

      // The whole conversation, when we are allowed to read it.
      const thread = await fetchCustomerThread(ticketId);

      const fromMessage = extractFromMessage(message);

      // Oldest turn first, so a later correction wins over an earlier value:
      // "the 28th" then "actually the 29th" must end up as the 29th. cleanSlots
      // drops empty values, so a turn that says nothing about dates cannot erase
      // the dates an earlier turn gave.
      const fromThread = {};
      // The subject first, so any comment can overrule it. See fetchCustomerThread.
      if (thread.subject) {
              Object.assign(fromThread, cleanSlots(extractFromMessage(thread.subject)));
      }
      if (thread.turns.length) {
              for (const turn of thread.turns) Object.assign(fromThread, cleanSlots(extractFromMessage(turn)));
      }

      const slots = Object.assign(
              fromThread,
              cleanSlots(params.llm_slots ?? params.llmslots ?? params.slots ?? params),
              cleanSlots(fromMessage)
      );

      // Every reference the customer named, when they named more than one.
      const refsSeen = new Set();
      for (const src of [fromMessage].concat(thread.turns.map(extractFromMessage))) {
              String(src._booking_refs || '').split(',').map(x => x.trim()).filter(Boolean).forEach(r => refsSeen.add(r));
              if (src.booking_ref) refsSeen.add(src.booking_ref);
      }
      const multipleRefs = refsSeen.size > 1 ? [...refsSeen] : [];

      /**
       * A reference WE found is not a reference the customer GAVE.
       *
       * The email lookup is genuinely useful: a customer who writes "I've lost my
       * voucher" and nothing else can be served instead of being asked for a code
       * they do not have. But acting on a booking the customer never named is
       * only acceptable where being wrong is cheap and reversible.
       *
       *   VOUCHER_RESEND  - re-sends the confirmation to the address that owns
       *                     the booking. If we picked the wrong booking, the
       *                     customer receives their own other voucher. Harmless.
       *   REQUOTE         - produces an internal note for an agent. Nobody is
       *                     charged, nothing is written to Odin. Harmless.
       *
       * Everything else is deliberately excluded. CANCELLATION,
       * PARTIAL_CANCELLATION and DATE_CHANGE move money or destroy a booking, and
       * "we guessed which one you meant" is not a defence. Those still require
       * the customer to name the reference themselves - which is the rule
       * Benjamin set the first day: never cancel a booking on an assumption.
       */
      const REF_FROM_HISTORY_IS_SAFE_FOR = ['VOUCHER_RESEND', 'REQUOTE'];
      let refFromHistory = '';
      if (thread.knownRef && !slots.booking_ref) {
              refFromHistory = thread.knownRef;
      }

      // Layer 0 - internal or partner sender. Layer 1 - native tags.
      // Either one stops the whole thing, before any topic is considered.
      const fromTags = detectFromTags(tags);
      const blocked = detectInternalSender(message, senderEmail, thread.subject) || (fromTags && fromTags.blocked ? fromTags : null);
      if (blocked) {
              const note = blocked.source === 'internal_sender'
                ? 'This is internal or partner mail, not a customer request. Route it to the right team - no flow should answer it.'
                : blocked.source === 'forwarded_mail'
                ? 'This is a forwarded message, not a request written by the customer. A human should read it before any flow acts.'
                : 'Zendesk classified this as unsolicited mail or a job application. No flow should answer it.';
              return res.status(200).json({
                        topic: 'OTHER',
                        route: null,
                        source: blocked.source,
                        slots: {},
                        ready: false,
                        missing: [],
                        missingLabels: [],
                        missinglabels: [],
                        next_question: null,
                        nextquestion: null,
                        action: 'STOP',
                        agentNote: note,
                        agentnote: note,
              });
      }

      // Layer 1b - two reasons to say nothing at all.
      //
      // NOOP is not HANDOVER. HANDOVER means "a human must read this" and is
      // worth a note and a tag. NOOP means "there is nothing here to do, by
      // anyone" - and the right amount of output for that is none. A tag on
      // every thank-you would bury the tags that matter.
      const noop = thread.agentReplied
        ? { source: 'agent_answered',
            note: 'A colleague has already answered this ticket in public. The ' +
                  'automation stays out of it - the conversation is theirs.' }
        : isCourtesyOnly(message)
        ? { source: 'courtesy_only',
            note: 'The customer only thanked us or said goodbye. Nothing to do.' }
        : null;
      //
      // The verdict is decided here but NOT returned here. An early return that
      // strips the payload starves every caller that does not read `action` -
      // and the topic flows do not: they read `transcript` and
      // `booking_reference` and carry on. On ticket 581767 that produced an
      // empty intent, an empty reference, and an Odin call with nothing in it.
      //
      // So NOOP now rides along with the full answer, applied at the end. The
      // gatekeeper's branch on `action` still stops the run silently; a flow
      // that ignores `action` still gets everything it had before.

      // Layer 2 - Alpy vocabulary. Layer 3 - whatever the caller's model said.
      // THE ORDER OF THE LAYERS, REVISED (2 September 2026).
      //
      // The first version put the native Zendesk intent tag above everything.
      // That tag is written ONCE, on the first message, and it stays on the
      // ticket for life - so a ticket opened with "cancel my booking" carried
      // intent__travel__booking_cancellation__cancel into every later message,
      // and "can you add a helmet?" three days later was routed to the
      // Cancellation Handler, which said "not a cancellation" and handed over.
      // Measured on 15 Aug - 2 Sep: 7 of the 8 tickets carrying that tag ended
      // exactly there. A flow chain cannot survive a layer that never changes.
      //
      // So the native tag now speaks only on the FIRST customer message, and
      // only when the keyword layer and the model are both silent. NEVER_ANSWER
      // is unchanged: unsolicited mail is unsolicited on every turn.
      //
      // The pending topic (awaiting__<topic>) keeps its place above the model
      // for the answer to a question we asked - "B1AF9J" alone must still land
      // on the topic that asked for it. But a customer who CHANGES SUBJECT is
      // not answering us: when the model, reading the whole thread, sees a
      // different action topic - a cancellation while we were waiting on a
      // quote, a date change while we were waiting on a cancellation consent -
      // the model wins. The list below is deliberately the action topics only:
      // QUOTE, REQUOTE and GENERAL_QUESTION are what a model tends to say about
      // any follow-up, and they must not break a slot-collection in progress.
      const kw = detectFromKeywords(message);
      const llm = llmTopic ? { topic: llmTopic, source: 'llm', blocked: false } : null;
      const pend = pendingTopic ? { topic: pendingTopic, source: 'pending_topic', blocked: false } : null;
      const off = offeredTopic ? { topic: offeredTopic, source: 'offered_topic', blocked: false } : null;
      const nativeTopic = (fromTags && !fromTags.blocked) ? fromTags : null;
      const firstTurn = !thread.turns || thread.turns.length <= 1;
      const SWITCHES_SUBJECT = ['CANCELLATION', 'PARTIAL_CANCELLATION', 'DATE_CHANGE',
                                'VOUCHER_RESEND', 'DEPOT_SWITCH', 'CANCELLATION_AFTER', 'PERSONAL_INFO',
                                'DUPLICATE_BOOKING'];
      const modelSwitches = (base) => llm && llm.topic !== base.topic && SWITCHES_SUBJECT.includes(llm.topic);

      let decision;
      if (kw) decision = kw;
      else if (pend && modelSwitches(pend)) decision = { topic: llm.topic, source: 'llm_over_pending', blocked: false };
      else if (pend) decision = pend;
      else if (off && modelSwitches(off)) decision = { topic: llm.topic, source: 'llm_over_offered', blocked: false };
      else if (off) decision = off;
      else if (llm && llm.topic !== 'OTHER') decision = llm;
      else if (nativeTopic && firstTurn) decision = nativeTopic;
      else if (llm) decision = llm;
      else decision = { topic: 'OTHER', source: 'none', blocked: false };

      /*
       * A rental request is a rental request even when it never says "quote".
       *
       * Every layer above matches WORDS. Emma's second mail contained none of
       * ours - no "quote", no "price", no "how much" - and yet it was a
       * complete rental request: a resort, a period, a party and two levels.
       * Word-matching had nothing to catch, so it fell to OTHER and a human
       * read a mail we could have priced.
       *
       * This last layer matches SHAPE instead. When nothing else claimed the
       * message and the customer has stated the facts a quote is built from,
       * that is a quote request whatever vocabulary they used, in any
       * language - which is the point, because the shape is the same in all
       * six.
       *
       * Three conditions, and all three are needed:
       *   - a period, which is what separates a rental from a question;
       *   - a place, or a headcount, so we are not reading a stray date;
       *   - a word about renting or equipment, so a hotel confirmation
       *     forwarded to us does not become a quote.
       * A message naming an existing booking is excluded outright: that is a
       * change to something that exists, and the flows that handle it match on
       * words for good reasons.
       */
      if (decision.topic === 'OTHER' && !decision.blocked) {
              const stated = extractFromMessage(message);
              const RENT_CUE = new RegExp(
                'rent(?:al|ing|s)?|hire|equipment|gear|\\bski\\b|skis|snowboard|' +
                'lou(?:er|ons|ation)|location de|mat[eé]riel|' +
                'mieten|miete|verleih|ausr[uü]stung|ausleihen|' +
                'huren|verhuur|uitrusting|' +
                'noleggi\\w*|attrezzatura|' +
                'alquil\\w*|equipo', 'i');
              // Somebody who has already booked is not asking for a price. They
              // say so in the first sentence - "I have just booked", "j'ai
              // réservé", "habe gebucht" - and #542887 slipped through on the
              // shape alone before this guard existed.
              const ALREADY_BOOKED = new RegExp(
                '\\b(?:(?:have|has|i|we)\\s+(?:just\\s+|already\\s+)?(?:booked|reserved|made a booking)|' +
                'j(?:\'|’)ai\\s+(?:bien\\s+|d[eé]j[aà]\\s+)?r[eé]serv[eé]|nous avons r[eé]serv[eé]|' +
                'habe\\s+(?:gerade\\s+|bereits\\s+|schon\\s+)?gebucht|haben\\s+(?:gerade\\s+)?gebucht|' +
                'heb\\s+(?:zojuist\\s+|al\\s+)?geboekt|hebben\\s+geboekt|' +
                'ho\\s+(?:appena\\s+|gi[aà]\\s+)?prenotato|abbiamo prenotato|' +
                'he\\s+(?:ya\\s+)?reservado|hemos reservado)\\b', 'i');
              if (stated.start_date && stated.end_date && !stated.booking_ref &&
                  (stated.adults || stated.equipment_level) &&
                  RENT_CUE.test(String(message)) &&
                  !ALREADY_BOOKED.test(String(message))) {
                        decision = { topic: 'QUOTE', source: 'quote_by_shape', blocked: false };
              }
      }

      let topic = decision.topic;

      // Apply the history reference, but only where it is safe (see above).
      // Done here rather than earlier because the rule depends on the topic, and
      // the topic is only decided on the line above.
      let usedRefFromHistory = false;
      if (refFromHistory && REF_FROM_HISTORY_IS_SAFE_FOR.includes(topic)) {
              slots.booking_ref = refFromHistory;
              usedRefFromHistory = true;
      }

      // ── What they booked last time ───────────────────────────────────────────
      //
      // Read for a QUOTE or a REQUOTE, and for one reason: a returning customer
      // who writes "the same as last year" is telling us the answers, not asking
      // to be interviewed. On 581788 we asked that customer about children when
      // the booking they were pointing at held two adults.
      //
      // The reference can come from either side - one the customer quoted, or
      // one the email lookup found - because reading a booking changes nothing.
      // What it may DO with what it reads is the part that is fenced.
      let history = '';
      let historyApplied = [];

      // Before asking WHERE, look at what they already wrote. A shop name they
      // mentioned - even one they ruled out - names the town exactly.
      let placeFound = null;
      if ((topic === 'QUOTE' || topic === 'REQUOTE' || topic === 'GENERAL_QUESTION') &&
          !slots.resort_name && !slots.shop_name) {
              const wholeThread = [thread.subject, message]
                .concat(thread.turns || []).filter(Boolean).join('\n');
              // A shop name first - it pins the town exactly and often the shop
              // too. Then the town itself, which is what most customers write.
              placeFound = await resolvePlaceFromShops(wholeThread)
                        || await resolveTownFromShops(wholeThread);
              if (placeFound) {
                        slots.resort_name = placeFound.town;
                        historyApplied.push('resort_name_from_shop');
                        // A shop named positively is a preference worth keeping.
                        // A shop refused is never proposed, and never becomes a slot.
                        if (placeFound.shops.length === 1 && !placeFound.refused.length) {
                                  slots.shop_name = placeFound.shops[0];
                                  historyApplied.push('shop_name_from_mention');
                        }
              }
      }
      const wantsSame = saysSameAsBefore(message) ||
                        (thread.turns || []).some(saysSameAsBefore);
      const refForHistory = slots.booking_ref || refFromHistory;

      if ((topic === 'QUOTE' || topic === 'REQUOTE') && refForHistory) {
              history = await fetchBookingHistory(refForHistory);
      }

      // Prefill ONLY on the customer's own instruction, and only the choices
      // that survive a year. Dates never carry: nobody means the same week
      // twelve months on, and a silently reused date is the 581658 failure
      // wearing different clothes. The ages of children are not carried either
      // - a child who was 7 last winter is 8 now, and a quote priced on last
      // year's age is wrong at the till, which is the exact harm children_ages
      // exists to prevent.
      if (history && wantsSame && topic === 'QUOTE') {
              const townMatch = history.match(/resort ([^;(]+)/);
              if (townMatch && !slots.resort_name && !slots.shop_name) {
                        slots.resort_name = townMatch[1].trim();
                        historyApplied.push('resort_name');
              }
              if (!slots.equipment_level) {
                        const kinds = [];
                        if (/\bski\b/.test(history)) kinds.push('ski');
                        if (/snowboard/.test(history)) kinds.push('snowboard');
                        if (kinds.length) {
                                  slots.equipment_level = 'same as booking ' + refForHistory +
                                                          ' (' + kinds.join(' and ') + ') - see the history line in the transcript';
                                  historyApplied.push('equipment_level');
                        }
              }
      }

      // Children: assumed absent when nobody mentions one, asked for when
      // somebody does.
      //
      // The slot sits in `assumes` now, so silence means "no children" and the
      // quote goes out with that assumption printed. What must NOT be assumed
      // is a child the customer has actually told us about: "us two and our
      // son" is a party of three, and pricing the son as an adult is the wrong
      // price at the till that this slot was written to prevent.
      //
      // Only the extractor can tell the two apart, because only it read the
      // message. So it flags a child-without-an-age, and the requirement is
      // handed back to checkSlots for that case alone. Computed over the whole
      // thread: the child may have been mentioned in the first mail and the
      // dates in the second.
      const partyText = [thread.subject, message].concat(thread.turns || [])
        .filter(Boolean).join('\n');
      const childrenNeedAsking =
        findParty(partyText)._children_no_age === 'yes' &&
        !SLOTS.children_ages.looksValid(slots.children_ages);
      const extraNeeds = childrenNeedAsking ? ['children_ages'] : [];

      // Not const: a second pass over an unanswered paid option rewrites this.
      // See the declineUnstatedExtras block below.
      let check = checkSlots(topic, slots, extraNeeds);

      /*
       * The level: assumed when it is the last thing missing, asked when it is
       * not.
       *
       * 84% of real quote requests never state one, so requiring it turned the
       * majority of them into a questionnaire. Quoting the mid range and saying
       * so is the better trade, because the quote is something the customer
       * edits rather than an invoice - but only when we would otherwise send
       * nothing at all. If we are writing to ask for the resort or the dates,
       * the level rides along in that same question at no cost, and an asked
       * level beats an assumed one every time.
       *
       * So the slot sits in `assumes`, and this puts it back into `needs` for
       * exactly the case where a question is going out anyway.
       */
      if (topic === 'QUOTE' && check.missing.length) {
              for (const name of ['equipment_level', 'adults']) {
                        if (!SLOTS[name].looksValid(slots[name])) extraNeeds.push(name);
              }
              check = checkSlots(topic, slots, extraNeeds);
      }
      // Two different things, deliberately kept apart.
      //
      // askedQuestions is what the customer actually wanted to know. It is the
      // only one that may suppress the repeat-ask escalation: a customer who
      // asked us something instead of answering has not gone quiet, so we answer
      // and ask again rather than hand over. Facts we owe them because we are
      // about to ask for a paid option say nothing about whether they replied,
      // and letting those suppress the escalation would disable the loop guard
      // on every quote - which is the bug that made 581695 seventeen messages.
      const askedQuestions = detectProductQuestion(message);
      // Optional extras are priced out, not asked about - but they are still
      // named.
      //
      // boots, helmets and damage & theft protection are no longer gates (see
      // ROUTES.QUOTE in _slots.js): silence on a paid option means the customer
      // does not want it, so the quote is built without it and goes out at once.
      // The one thing we owe them is knowing the option exists, at the price it
      // costs, so the figure they receive is not quietly missing something they
      // would have taken. That belongs in the reply, not in a question.
      const unstatedExtras = topic === 'QUOTE'
        ? factsForMissing(['boots', 'helmets', 'insurance'].filter(n => !hasSlot(slots, n)))
        : [];
      // THE STATE OF THE BOOKING, SAID BEFORE WE ASK ANYTHING (581920).
      //
      // Only for the topics that act on an existing booking, and only when the
      // customer named the reference themselves. The fact goes into `answers`,
      // which the composing prompt is required to state before its question - so
      // a customer whose booking is cancelled learns it in the same message that
      // asks them for the dates, instead of two messages later.
      //
      // The topic is NOT changed here. Date Change reads Odin itself and now
      // turns a cancelled booking into a re-booking offer with a priced basket;
      // this only stops us asking as though nothing were wrong.
      const ACTS_ON_A_BOOKING = ['DATE_CHANGE', 'CANCELLATION', 'PARTIAL_CANCELLATION'];
      const bookingFacts = [];
      if (ACTS_ON_A_BOOKING.includes(topic) && slots.booking_ref && !usedRefFromHistory) {
              const state = await fetchBookingState(slots.booking_ref);
              if (state && state.found && (state.cancelled || state.expired)) {
                        bookingFacts.push({ slot: '_booking_state', fact:
                          'Booking ' + String(slots.booking_ref).toUpperCase() + ' shows as ' +
                          (state.cancelled ? 'CANCELLED' : 'EXPIRED') + ' in our system, so it carries no ' +
                          'dates or items we can change. Say this plainly, do not guess why it happened, ' +
                          'and offer to prepare a new booking for the dates they want instead.' });
              } else if (state && !state.found) {
                        bookingFacts.push({ slot: '_booking_state', fact:
                          'No booking exists under the reference ' + String(slots.booking_ref).toUpperCase() +
                          '. Ask them to check it against their confirmation email - do not act on it.' });
              }
      }

      const productQuestions = mergeFacts(bookingFacts, mergeFacts(askedQuestions, mergeFacts(factsForMissing(check.missing), unstatedExtras)));
      const missingLabelsOf = c => c.missing.map(req => {
              const first = req.split('|')[0];
              return SLOTS[first] ? SLOTS[first].label : first;
      }).join(', ');

      // ANSWER means the owning flow may run. ASK means we know what the customer
      // wants but not enough to act - the flow asks one question. HANDOVER means
      // we could not identify a capability: a human reads it.
      let action = 'HANDOVER';
      if (topic !== 'OTHER') action = check.ready ? 'RUN' : 'ASK';

      // Two ways a correct-looking ASK is the wrong answer.
      let escalation = null;

      // The second change to make, when a message asks for two we can chain.
      // Empty for every other message - a Zendesk branch compares strings, and
      // null renders as the word "null".
      let secondTopic = '';

      // One: the request spans several bookings. No capability we have edits
      // five bookings at once, so asking for "the" reference can only loop.
      let targets = [];
      if (multipleRefs.length > 1 && topic !== 'OTHER') {
              const wholeText = [thread.subject, message]
                .concat(thread.turns || []).filter(Boolean).join('\n');
              targets = designatedRefs(wholeText, multipleRefs);
      }

      if (targets.length === 1) {
              // Exactly what the customer pointed at, and nothing else. The other
              // references they named are context - on 581832, "First booking:
              // B91NDK" was the customer telling us which one to keep.
              slots.booking_ref = targets[0];
              check = checkSlots(topic, slots, extraNeeds);
              action = check.ready ? 'RUN' : 'ASK';
              escalation = null;
      } else if (targets.length > 1 && topic === 'CANCELLATION') {
              // Several bookings genuinely to cancel - and as of 31/08/2026 the
              // Cancellation Handler loops. Its `For each booking to cancel` step
              // iterates the references, and inside the loop each booking is read,
              // cancelled through Odin, verified, and refunded on its own payment.
              // One reply goes out at the end listing what was cancelled.
              //
              // "Our flows act on one booking at a time" was a statement about the
              // plumbing, and the plumbing changed. Handing this to a human now
              // costs an agent a job the flow does correctly.
              //
              // booking_ref carries the first target so checkSlots() sees a
              // complete request; the whole list travels in targetRefs /
              // targetRefsText, and the flow re-derives it from the customer's own
              // words with the same rule this file uses.
              slots.booking_ref = targets[0];
              check = checkSlots(topic, slots, extraNeeds);
              action = check.ready ? 'RUN' : 'ASK';
              escalation = null;
      } else if (targets.length > 1) {
              // Every other capability still acts on ONE booking per run - Date
              // Change rewrites a rental period, Partial cancellation drops items
              // from a single booking, and neither has a loop. Passing the first
              // of two would change one, tell the customer it was done, and
              // silently leave the second standing.
              //
              // That is worse than handing over, so we hand over, and we say
              // exactly what has to happen.
              action = 'HANDOVER';
              escalation = 'The customer asked us to act on ' + targets.length +
                           ' bookings (' + targets.join(', ') + '). Each one is clearly ' +
                           'designated - do not ask them which. Only cancellation runs on ' +
                           'several bookings at once, so handle these by hand, together, ' +
                           'and reply once.';
      } else if (mutatingTopicsIn(message).length > 1) {
              // ONE MESSAGE, TWO CHANGES TO THE SAME BOOKING (582063).
              //
              // "Cancel person 1: test test AND shift the dates by one day" went
              // to Date Change alone. The dates were examined, the person was
              // left on the booking, the ticket was tagged answered, and the cart
              // the reply offered still contained the person the customer wanted
              // removed. Every capability here changes ONE thing; none of them
              // reads the rest of the message before acting.
              //
              // So when a message asks for two different changes, nobody runs.
              // Only booking-changing topics count - a quote next to a question is
              // read-only and stays automatic.
              const both = mutatingTopicsIn(message);

              // ONE PAIR IS CHAINED. EVERY OTHER PAIR STILL STOPS.
              //
              // 582089: "annulez la personne 1 : test test ET decalez les dates
              // d'une journee". The guard read both correctly and did nothing,
              // which is what it was built to do (582063, same booking) - but
              // the customer still had to be served by hand. So this pair now
              // runs both capabilities, one after the other.
              //
              // The ORDER is not a convenience. Removing the person first means
              // the date-change price comparison runs on the booking as it will
              // actually be, instead of on one that still carries a line about
              // to disappear. It also happens to be the only possible order:
              // Date Change sits at the 60-step ceiling and cannot carry the
              // step that would hand over to a successor.
              //
              // Only this pair. Any other combination keeps handing over, and
              // deliberately so: chaining is only safe where the second flow's
              // view of the booking after the first one has been reasoned
              // through, and that has been done here and nowhere else.
              const CHAIN_FIRST = 'PARTIAL_CANCELLATION';
              const CHAIN_SECOND = 'DATE_CHANGE';
              const chainable = both.length === 2 &&
                                both.indexOf(CHAIN_FIRST) > -1 &&
                                both.indexOf(CHAIN_SECOND) > -1;

              if (chainable) {
                        topic = CHAIN_FIRST;
                        secondTopic = CHAIN_SECOND;
                        // The slots were checked against whatever topic the
                        // keywords picked first. Re-check them against the one
                        // we are actually about to run, or a ready request looks
                        // incomplete and a missing reference goes unnoticed.
                        check = checkSlots(topic, slots, extraNeeds);
                        action = check.ready ? 'RUN' : 'ASK';
                        escalation = null;
              } else {
                        action = 'HANDOVER';
                        escalation = 'This message asks for TWO different changes to the booking (' +
                                     both.join(' + ') + '), and each of our capabilities performs only one. ' +
                                     'Doing half of it and answering would leave the rest undone on a ticket ' +
                                     'marked as handled. Make both changes together, then reply once.';
              }
      } else if (multipleRefs.length > 1 && topic !== 'OTHER') {
              action = 'HANDOVER';
              escalation = 'The customer named ' + multipleRefs.length + ' bookings (' +
                           multipleRefs.join(', ') + ') without saying, in a sentence we can ' +
                           'read, which of them to act on. Handle it manually - and do not ask ' +
                           'for "the" booking reference, it has already been given.';
      }

      // MORE THAN FIFTY IN FRANCE (582110). Skitruck, never a quote.
      const bigGroup = await franceBigGroup(message);
      if (bigGroup && bigGroup.size > BIG_GROUP_MIN && bigGroup.country === 'france') {
              action = 'HANDOVER';
              escalation = 'GROUP OF ' + bigGroup.size + ' IN FRANCE (' +
                           (bigGroup.town || 'destination stated in the message') + '). ' +
                           'We never quote a French group of more than fifty automatically. Send the ' +
                           'destination, the customer contact details and the approximate headcount to ' +
                           'alpy@skitruck.fr with Fabien (fg@alpy.com) in copy, and acknowledge to the ' +
                           'customer that our groups team will come back to them. Do not ask them about ' +
                           'boots, helmets or cover.' +
                           (escalation ? ' Also relevant: ' + escalation : '');
      }

      // PAID, AND NOTHING RECEIVED (582095). A person, and quickly.
      if (paidButNoBooking(message)) {
              action = 'HANDOVER';
              escalation = 'THE CUSTOMER SAYS THEY WERE CHARGED BUT HAVE NO BOOKING REFERENCE AND ' +
                           'NO CONFIRMATION. Check first whether a booking exists on their email: if ' +
                           'it does, resend the confirmation and find out why it never went out; if it ' +
                           'does not, a payment was taken for nothing and it has to be traced and ' +
                           'refunded. Do not let this sit in a queue.' +
                           (escalation ? ' Also relevant: ' + escalation : '');
      }

      // AND ABOVE ALL OF IT: the customer asked for a person (582070).
      //
      // Placed after the whole chain on purpose, so that it wins whatever the
      // branches above decided. A customer who has asked to speak to someone
      // gets a person, not a better robot.
      if (wantsHuman(message)) {
              action = 'HANDOVER';
              escalation = 'THE CUSTOMER HAS ASKED TO SPEAK TO A PERSON. Nothing automatic may ' +
                           'answer this ticket - reply yourself, and say who you are. ' +
                           (escalation ? 'Also relevant: ' + escalation : '');
      }

      // Asked once. The second time, silence on a paid option means no.
      //
      // This is what makes it safe to gate on boots, helmets and damage & theft
      // protection at all. They are real money - AlpinGuaranty is 15% of the
      // rental, which on a group of fifteen is not a detail to discover in the
      // basket - so the customer is asked before the price is built. But a
      // customer who replies about dates and levels and says nothing about
      // helmets has not gone quiet: they have shown what they care about. Asking
      // again would be pedantry, and escalating to a human over an unmentioned
      // helmet is how 581739 ended with a note about a sentence the customer had
      // already written.
      //
      // So on the second pass, if the only holes left are optional extras, they
      // are recorded as declined and the quote goes out. The reply still names
      // them - unstatedExtras above was computed before this ran, on purpose -
      // so the customer sees what was left out and at what price, and can ask
      // for it in one line.
      //
      // Anything that is not an optional extra - a resort, a date, the ages of
      // the children - is never filled in on the customer's behalf. A guessed
      // age is a wrong price discovered at the till.
      const OPTIONAL_EXTRAS = ['boots', 'helmets', 'insurance'];
      const alreadyAsked = pendingTopic === topic;
      if (action === 'ASK' && alreadyAsked &&
              check.missing.length && check.missing.every(req => OPTIONAL_EXTRAS.includes(req))) {
              check.missing.forEach(req => { slots[req] = 'no'; });
              check = checkSlots(topic, slots, extraNeeds);
              action = check.ready ? 'RUN' : action;
      }

      // Two: we already asked, they answered, and we are about to ask again.
      //
      // The awaiting__<topic> tag means a question went out on this ticket. If
      // the reply still leaves the same hole, repeating the question is how
      // 581695 reached seventeen messages. A human reads it instead.
      // A customer who asked a question instead of answering ours has not gone
      // quiet - they are waiting on us. Answer, ask again, and do not escalate.
      if (action === 'ASK' && pendingTopic === topic && !askedQuestions.length) {
              action = 'HANDOVER';
              escalation = 'We already asked this customer for ' + missingLabelsOf(check) +
                           ' and their reply still does not contain it. Asking a second time ' +
                           'is how a ticket turns into a loop - read the thread and answer.';
      }

      const missingLabels = check.missing.map(req => {
              const first = req.split('|')[0];
              return SLOTS[first] ? SLOTS[first].label : first;
      });


      const body = {
              topic,
              route: ROUTES[topic] ? ROUTES[topic].flow : null,
              source: decision.source,
              // Which keyword rule fired, when one did. Diagnostic only.
              matched_rule: decision.rule !== undefined ? decision.rule : null,
              slots,
              ready: check.ready,
              missing: check.missing,
              missingLabels,
              next_question: check.nextQuestion,
              // Several holes -> one message asking for all of them. See the
              // comment in _slots.js: a flow has no memory between comments, so
              // one question per turn can never collect six things.
              next_question_all: check.nextQuestionAll,
              // What we took by default on the paid extras, in one sentence the
              // reply must print as-is.
              //
              // This is the other half of not gating on boots, helmets and
              // protection: we price them on an assumption, and the customer
              // reads the assumption in the same message as the figure. An
              // assumption stated is correctable in one word; an assumption
              // hidden is a surprise at the till, which is what we were trying
              // to avoid when we made them gates in the first place.
              assumptions: check.assumedSentence || '',
              // The booking we found on the customer's email, and whether this
              // topic was allowed to use it. Both travel so a flow - or a human
              // reading the run - can see that the reference was inferred, not
              // quoted.
              ref_from_history: refFromHistory,
              used_ref_from_history: usedRefFromHistory,
              // The previous booking, in one line, and which slots it filled.
              // Both travel so a human reading the run can see that a value came
              // from history rather than from the customer's message.
              booking_history: history,
              history_applied: historyApplied.join(','),
      resolved_place: placeFound ? placeFound.town : '',
      excluded_shops: placeFound ? placeFound.refused.join(' | ') : '',
              assumed_slots: (check.assumed || []).map(a => a.slot).join(','),
              action,
              // The whole gate in one value.
              //
              // A flow's entry condition can test exactly one thing, but the
              // question it must answer is two: "is this my subject" AND "is
              // there enough to act on". Returning the topic ONLY when the
              // answer is RUN collapses both into a single comparison, so
              // Quote Generator asks `run_topic Is QUOTE` and gets a no both
              // when the customer wanted a cancellation and when they wanted a
              // quote but gave no dates.
              //
              // Empty string, never null: a Zendesk Branch on a Text variable
              // compares strings, and null renders as the word "null".
              run_topic: action === 'RUN' ? topic : '',
              // The change to make AFTER the one that is about to run. Only
              // ever set when both were asked for in the same message and the
              // pair is one we chain - see the branch above. The gatekeeper
              // turns this into a tag, and the first flow reads that tag to
              // start the second. Empty on every other message.
              second_topic: action === 'RUN' ? secondTopic : '',
              // Facts the reply must state before asking for anything else.
              answers: productQuestions.length ? productQuestions.map(a => a.fact).join(' ') : '',
              // How much of the conversation we could read. 0 means we are back
              // to one message at a time - say so rather than pretend.
              turns_read: thread.count,
              thread_status: thread.status,
              // What today is.
              //
              // A detector prompt told "if the date has already passed this year,
              // use next year" has no idea what this year is, and on 581710 it
              // decided December meant 2024. Everything after that was wasted: no
              // live price exists for a past season, so the quote went out with no
              // figure and a link alpy.com silently rewrote to another week.
              //
              // A model cannot know the date. It can be told.
              today: new Date().toISOString().slice(0, 10),
              // The conversation, for a flow's own detector to read instead of
              // the last comment alone.
              //
              // Turns are numbered and ordered oldest first so a prompt can be
              // told plainly that the last one wins. Without the numbering a
              // model reading five paragraphs has no way to know which "the
              // 28th" superseded which.
              //
              // Capped at 8000 characters from the END: a long thread's useful
              // information is in its recent turns, and an unbounded transcript
              // would eventually cost more than the answer is worth.
              //
              // FAIL-SOFT. When the thread cannot be read - no credentials, an
              // expired token, a ticket id the flow did not pass - this falls
              // back to the message we were given. A flow whose detector reads
              // `transcript` must never receive an empty string, because an
              // empty detector input classifies as OTHER and closes the gate on
              // every ticket at once. Degraded memory is a bad day; a silent
              // outage across all capabilities is a bad week.
              transcript: buildTranscript(thread.turns, thread.subject, thread.knownRef, history) ||
                (String(message || '').trim()
                  ? 'Customer, message 1 of 1:\n' + String(message).trim()
                  : ''),
              bookingRefs: multipleRefs.length > 1 ? multipleRefs : null,
      // Every booking the customer asked us to act on. The flow feeds this list
      // to its for_each loop; it is not a fallback for booking_ref.
      targetRefs: targets,
      targetrefs: targets,
      // The same list as plain text. An action flow passes text between steps far
      // more reliably than it passes an array, and the cancel endpoint splits on
      // commas - so this is what the flow should feed to bookingreference.
      targetRefsText: targets.join(', '),
      targetrefstext: targets.join(', '),
      // Named by the customer, deliberately NOT acted on.
      refsNotActedOn: targets.length ? multipleRefs.filter(r => targets.indexOf(r) === -1) : [],
              // A CHAINED RUN CARRIES ITS PLAN IN THE AGENT NOTE.
              //
              // agentNote is the internal channel already exposed to the
              // gatekeeper, and on a RUN with nothing to escalate it is empty.
              // So the plan travels here rather than through a new output on the
              // custom action: adding one mints a new revision and every step
              // that uses the action has to be re-pinned by hand, which is a
              // real risk for a value only one code step reads.
              //
              // The marker is on the first line, machine-readable, and the
              // sentence after it is for the human who opens the ticket.
              agentNote: secondTopic ? ('PLAN_THEN: ' + secondTopic + String.fromCharCode(10) +
                'Two changes were asked for in one message. ' + topic + ' runs now; ' +
                secondTopic + ' is started automatically as soon as it has finished. ' +
                'The customer gets one reply for each - do not redo either by hand ' +
                'unless a note says it failed.')
                : (escalation ? escalation : (action === 'HANDOVER'
                ? 'No capability matches this message. Read it and answer manually.'
                : (action === 'ASK'
                    ? 'We know what the customer wants but not enough to act. Missing: ' + missingLabels.join(', ') + '.'
                    : null))),
              // next_question is a suggestion, never an instruction to send.
              // The flow must still pass its own gate before asking a customer
              // anything in public.
              _contract: 'The caller decides whether to send next_question. This endpoint never authorises a public reply.',
      };

      // A NOOP verdict overrides the action and says why, and changes nothing
      // else: the transcript, the slots and the booking reference stay exactly
      // as computed, because a caller may need them even when nobody should act.
      if (noop) {
              body.action = 'NOOP';
              body.source = noop.source;
              body.agentNote = noop.note;
      }

      // Zendesk forces custom-action output names to lowercase and JSON keys are
      // case-sensitive, so every camelCase key is aliased.
      body.runtopic = body.run_topic;
      body.turnsread = body.turns_read;
      body.threadstatus = body.thread_status;
      body.transcript = body.transcript;
      body.bookingrefs = body.bookingRefs;
      body.nextquestion = body.next_question;
      body.nextquestionall = body.next_question_all;
      // missinglabels carries the WRITTEN QUESTION, not a list of nouns.
      //
      // This is a repurposing, and it is deliberate. The Zendesk custom action's
      // response schema was captured before next_question_all existed, so the
      // flow's prompt can only reference the leaves that schema declares -
      // action, agentnote, answers, missinglabels, next_question, run_topic,
      // topic, transcript. Adding one mints a new operationId and every step
      // bound to the old one goes blind, which means deleting and re-adding ten
      // steps across five flows. Not worth it.
      //
      // So the composed question rides on `missinglabels`, exactly as `today`
      // rides on `transcript`. The field's MEANING is unchanged - it is still
      // "what we still need" - only its form improves, from
      //   "first day of the rental, last day of the rental, number of adults"
      // to the sentence _slots.js actually wrote, warnings and all. That is the
      // point: the careful wording about children's ages, or about a paid
      // option and its price, was being thrown away and re-derived by a model
      // from three bare nouns. Now the model receives the finished sentence and
      // its job is to carry it across, not to invent it.
      //
      // `missingLabels` (camelCase, the array) is untouched for any caller that
      // wants the raw list.
      body.missinglabels = check.nextQuestionAll || missingLabels.join(', ');
      body.reffromhistory = body.ref_from_history;
      body.bookinghistory = body.booking_history;
      body.historyapplied = body.history_applied;
      body.usedreffromhistory = body.used_ref_from_history;
      body.agentnote = body.agentNote;

      return res.status(200).json(body);
}
