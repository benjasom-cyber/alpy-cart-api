// api/_intents.js — dictionnaire des intentions (D-55).
//
// Construit à partir du courrier client des saisons 2024-25 et 2025-26 (≈ 40 000 mails
// étiquetés par les agents). Chaque entrée est une expression régulière, sa langue, un
// poids, et la preuve dans le corpus : df = nombre de mails où elle apparaît,
// prec = part de ces mails portant l'étiquette du sujet (mesuré par dict/eval.mjs).
//
// Utilisation : scoreIntents(text) → [{topic, score, hits:[...]}] trié. intent.js s'en
// sert APRÈS les KEYWORDS (règles nées d'incidents, prioritaires) et AVANT le modèle :
// un sujet net (score ≥ MIN_SCORE et marge ≥ MIN_MARGIN sur le second) est retenu sans
// appel au modèle ; sinon les scores sont passés au modèle comme indices.
//
// Règles d'écriture : tout est comparé en minuscules SANS accents (voir norm()) ;
// jamais de référence de réservation ici (elles sont extraites ailleurs, casse stricte).

const MIN_SCORE = 3;
const MIN_MARGIN = 2;

// poids : 3 = quasi certain (prec ≥ 0.85), 2 = fort (0.7–0.85), 1 = indice (0.5–0.7)
const D = {
  CANCELLATION: {
    en: [
      [/\b(?:would|d|want|need|have|like|wish)\b.{0,12}\bto cancel (?:my|our|this|the) (?:booking|reservation|order|rental|hire)\b/, 3],
      [/\bplease cancel\b/, 2], [/\bcancel (?:my|our|this|the) (?:booking|reservation|rental|hire)\b/, 2],
      [/\bcancel(?:lation)? (?:of )?(?:my |our |the )?(?:entire |whole |full )?booking\b/, 2],
      [/\b(?:i|we) (?:would like to|want to|need to|have to|must) cancel\b/, 3],
      [/\bcan (?:i|we|you) cancel\b/, 2], [/\bcancel and refund\b/, 2],
      [/\bconfirm (?:the|this|my) cancellation\b/, 2], [/\bcancellation (?:request|confirmation)\b/, 2],
      [/\bfull refund\b/, 1], [/\bto cancel\b/, 1], [/\bcancel\b/, 1],
    ],
    de: [
      [/\b(?:buchung|reservierung) (?:bitte )?(?:zu )?stornieren\b/, 3], [/\bstornieren (?:sie )?bitte\b/, 2],
      [/\b(?:mochte|muss|will|wollen|mochten|mussen) (?:ich|wir) .{0,40}stornieren\b/, 3],
      [/\bhiermit storniere(?:n)? (?:ich|wir)\b/, 3], [/\bleider muss(?:en)? (?:ich|wir)\b/, 1],
      [/\bdie stornierung\b/, 2], [/\bstornierung der (?:buchung|reservierung)\b/, 3], [/\bbitte um (?:eine )?bestatigung\b/, 1],
      [/\b(?:komplett|vollstandig|ganz) stornieren\b/, 3], [/\bstornier\w*\b/, 1], [/\brucktritt\b/, 1],
    ],
    fr: [
      [/\b(?:je |nous )?(?:souhait\w+|voudr\w+|aimer\w+|dois|devons|veux|voulons) (?:d')?annuler\b/, 3],
      [/\bannuler (?:ma|notre|cette|la) (?:reservation|commande|location)\b/, 3], [/\bannulation (?:de )?(?:ma |la |cette )?reservation\b/, 3],
      [/\bdemande d'?annulation\b/, 3], [/\bmerci d'annuler\b/, 3], [/\bveuillez annuler\b/, 3],
      [/\bannulation totale\b/, 3], [/\bannul\w+\b/, 1], [/\bremboursement (?:integral|total|complet)\b/, 1],
    ],
    nl: [
      [/\b(?:boeking|reservering) (?:graag )?(?:te )?annuleren\b/, 3], [/\b(?:wil|willen|zou|zouden|moet|moeten) (?:ik|wij|we) (?:graag )?.{0,30}annuleren\b/, 3],
      [/\bgraag (?:mijn |onze |deze |de )?(?:boeking |reservering )?annuleren\b/, 3], [/\bde annulering\b/, 2], [/\bannuler\w+\b/, 1], [/\bcancelen\b/, 2],
    ],
    it: [[/\b(?:annullare|cancellare|disdire) (?:la |questa |mia )?(?:prenotazione|ordine)\b/, 3], [/\bannull\w+\b/, 1], [/\bdisdett\w+\b/, 2]],
    es: [[/\b(?:cancelar|anular) (?:la |mi |esta |nuestra )?reserva\b/, 3], [/\bcancelaci\w+\b/, 2], [/\banular\b/, 1]],
  },

  PARTIAL_CANCELLATION: {
    en: [
      [/\b(?:cancel|remove|delete|drop|take off) (?:the |a |one |two |\d+ )?(?:pair of )?(?:helmet|boots?|poles?|skis?|snowboard|shoes)s?\b/, 3],
      [/\b(?:cancel|remove) (?:one|two|\d+|a) (?:person|people|adult|child|skier|set)s?\b/, 3],
      [/\b(?:one|two|\d+) of (?:us|the (?:skiers|persons|people|children)) (?:will not|won't|cannot|can't|isn't|is not)\b/, 3],
      [/\bpartial(?:ly)? cancel/, 3], [/\bno longer (?:need|require)s? (?:the |a |his |her )?(?:helmet|boots?|poles?|skis?)\b/, 3],
      [/\b(?:keep|leave) the rest\b/, 2], [/\bonly (?:cancel|remove)\b/, 2], [/\b(?:instead of|rather than) (?:two|three|\d+)\b/, 1],
    ],
    de: [
      [/\bteil(?:weise )?storn/, 3], [/\bnur (?:den|die|das|ein|eine) .{0,20}(?:helm|schuhe|skischuhe|stocke|ski|snowboard) stornieren\b/, 3],
      [/\b(?:helm|skischuhe|schuhe|stocke) .{0,30}stornieren\b/, 2], [/\b(?:eine|ein|zwei|\d+) person(?:en)? .{0,30}stornieren\b/, 3],
      [/\b(?:der rest|die anderen|die ubrigen) (?:bleibt|bleiben)\b/, 3], [/\bkann (?:leider )?nicht mit(?:fahren|kommen)\b/, 2],
    ],
    fr: [
      [/\bannulation partielle\b/, 3], [/\bannuler (?:uniquement |seulement |juste )?(?:le |la |les |un |une )?(?:casque|chaussures|batons|skis?|snowboard)s?\b/, 3],
      [/\b(?:supprimer|retirer|enlever) (?:le |la |les |un |une )?(?:casque|chaussures|batons|skis?|personne|paire)\b/, 3],
      [/\bannuler (?:une|deux|\d+) personnes?\b/, 3], [/\bn'?(?:ai|avons) plus besoin (?:du|de la|des)\b/, 2], [/\bgarder le reste\b/, 3],
    ],
    nl: [
      [/\b(?:helm|schoenen|skischoenen|stokken|ski's?|snowboard) .{0,20}annuleren\b/, 3], [/\bannuleren van (?:de |een )?(?:helm|schoenen|stokken)\b/, 3],
      [/\b(?:een|twee|\d+) perso(?:on|nen) .{0,30}annuleren\b/, 3], [/\bhoe\w* geen .{0,20}meer\b/, 2], [/\bgedeeltelijk\b/, 3], [/\bde rest blijft\b/, 3],
    ],
    it: [[/\bannull\w+ (?:solo |soltanto )?(?:il |la |le |gli )?(?:casco|scarponi|bastoncini)\b/, 3], [/\bparzial\w*\b/, 2]],
    es: [[/\bcancelar (?:solo )?(?:el |la |los |las )?(?:casco|botas|bastones)\b/, 3], [/\bparcial\w*\b/, 2]],
  },

  CANCELLATION_AFTER: {
    en: [
      [/\b(?:i|we|she|he|they) (?:have |had )?returned (?:the|my|our|his|her|their) (?:equipment|skis?|gear|boots|rental)\b/, 3],
      [/\b(?:had to|has to|needed to) return\b/, 2], [/\bearly return\b/, 3], [/\bunused days?\b/, 3], [/\bdays? (?:not|un)used\b/, 3],
      [/\b(?:medical|doctor'?s?) (?:report|certificate|note|letter)\b/, 3], [/\b(?:injur\w+|hurt|broke|fractur\w+|torn)\b/, 1],
      [/\b(?:had|have) an accident\b/, 3], [/\b(?:ski(?:ing)? )?accident on (?:the )?(?:first|second|\d+(?:st|nd|rd|th)?)\b/, 3],
      [/\b(?:was|were|am|is) unable to (?:ski|use|continue)\b/, 2], [/\b(?:hospital|emergency|ambulance|x-?ray|surgery|physio)\b/, 1],
      [/\b(?:sick|ill|flu|covid|fever)\b/, 1], [/\bonhold\b/, 2], [/\bstopped skiing\b/, 2], [/\bonly (?:used|skied) (?:for )?(?:\d+|one|two|three) days?\b/, 3],
    ],
    de: [
      [/\b(?:nur )?(?:\d+|einen|zwei|drei) tage? (?:benutzt|genutzt|gefahren)\b/, 3], [/\bnicht genutzten? tage\b/, 3],
      [/\b(?:fruher|vorzeitig) (?:zuruck|abgegeben|zuruckgegeben)\b/, 3], [/\b(?:wieder |bereits |vorzeitig )?(?:abgegeben|zuruckgegeben|zuruckgebracht)\b/, 2],
      [/\b(?:arzt\w*|arztliche\w*) (?:attest|bescheinigung|bericht|zeugnis)\b/, 3], [/\battest\b/, 2], [/\bkrankenhaus\b/, 2],
      [/\b(?:ski)?unfall\b/, 2], [/\bverletz\w+\b/, 2], [/\b(?:gebrochen|bruch|kreuzband|banderriss)\b/, 2], [/\bkrank(?:heit|geworden)?\b/, 1], [/\bsturz\b/, 2],
    ],
    fr: [
      [/\bcertificat medical\b/, 3], [/\bcertificat\b/, 2], [/\battestation (?:medicale|du medecin)\b/, 3], [/\bmedecin\b/, 2],
      [/\b(?:accident|chute) (?:de ski|sur les pistes)?\b/, 2], [/\bbless\w+\b/, 2], [/\b(?:rendu|ramene|restitue) (?:le materiel|les skis|l'equipement)\b/, 3],
      [/\bmateriel rendu\b/, 3], [/\bjours? non utilises?\b/, 3], [/\bn'?(?:ai|avons) (?:pas )?pu (?:skier|utiliser)\b/, 2], [/\b(?:hopital|urgences|fracture|entorse|platre)\b/, 2],
      [/\bmalade\b/, 1], [/\bremboursement des jours\b/, 3],
    ],
    nl: [
      [/\bingeleverd\b/, 3], [/\bterug\s?gebracht\b/, 3], [/\b(?:ski)?ongeval\b/, 3], [/\bongeluk\b/, 2], [/\bziekenhuis\b/, 2], [/\bgevallen\b/, 1],
      [/\bgeblesseerd\b/, 3], [/\bgebroken\b/, 2], [/\bziek\b/, 1], [/\bgeen gebruik\b/, 2], [/\bniet (?:meer )?kunnen skien\b/, 2], [/\b(?:eerder|vroegtijdig) (?:ingeleverd|teruggebracht|gestopt)\b/, 3],
    ],
    it: [[/\bcertificato medico\b/, 3], [/\binfortun\w+\b/, 3], [/\bincidente\b/, 2], [/\brestituit\w+\b/, 2], [/\bospedale\b/, 2]],
    es: [[/\b(?:informe|certificado|parte) medico\b/, 3], [/\blesion\w*\b/, 3], [/\baccidente\b/, 2], [/\bdevuelt\w+\b/, 2], [/\bhospital\b/, 2]],
  },

  DATE_CHANGE: {
    en: [
      [/\bchange (?:the |my |our )?(?:booking |rental |reservation )?dates?\b/, 3], [/\bdates? (?:are|is) (?:wrong|incorrect)\b/, 3],
      [/\bwrong (?:dates?|week|day)\b/, 3], [/\b(?:move|shift|postpone|bring forward|extend|shorten) (?:the |my |our )?(?:booking|reservation|rental|dates?|holiday)\b/, 3],
      [/\b(?:a|one) day (?:later|earlier|too (?:long|many|much))\b/, 3], [/\bdate change\b/, 3], [/\bchange (?:of )?dates?\b/, 3],
      [/\b(?:should|need to|ought to) (?:be|start|end|run) (?:from |on |the )?\d/, 2], [/\binstead of (?:the )?\d/, 2], [/\bnew dates?\b/, 2],
      [/\b(?:start|end|first|last) (?:date|day) (?:should|needs to|has to|must) be\b/, 3], [/\bone day (?:less|more|shorter|longer)\b/, 3],
      [/\b(?:add|remove|drop|cancel|skip) (?:the |a |one )?(?:first|last|final|extra) day\b/, 3], [/\bonly need (?:it|them|the skis) (?:for|until|till)\b/, 2],
      [/\brebook\b/, 1], [/\bdates?\b/, 1],
    ],
    de: [
      [/\b(?:datum|daten|zeitraum|buchung|reservierung) (?:bitte )?(?:zu )?(?:verschieben|andern|anpassen|korrigieren)\b/, 3], [/\bverschieben\b/, 2],
      [/\b(?:falsches|falsche) (?:datum|daten|woche)\b/, 3], [/\b(?:im|beim) datum (?:vertan|geirrt|verwechselt)\b/, 3], [/\bdatum (?:falsch|stimmt nicht)\b/, 3],
      [/\b(?:einen|ein) tag (?:fruher|spater|langer|kurzer|weniger|mehr|zu viel)\b/, 3], [/\b(?:um )?(?:einen|zwei|\d+) tage? (?:verschieben|verlangern|verkurzen)\b/, 3],
      [/\bauf den (?:zeitraum|\d)/, 2], [/\bstatt (?:vom|am|des|dem) \d/, 2], [/\bsoll(?:te)? (?:vom|am|bis) \d/, 2], [/\bnur bis (?:zum )?\d/, 3],
      [/\b(?:ersten|letzten) tag (?:streichen|stornieren|entfernen)\b/, 3], [/\bandere?s? (?:datum|daten|zeitraum)\b/, 2], [/\bumbuch\w+\b/, 3],
    ],
    fr: [
      [/\bmodifier (?:la |les |mes |nos )?dates?\b/, 3], [/\bchang\w+ (?:de |la |les |mes )?dates?\b/, 3], [/\b(?:decaler|reporter|avancer|prolonger|raccourcir) (?:la |ma |notre )?(?:reservation|location|dates?|sejour)\b/, 3],
      [/\b(?:erreur|trompe\w*) (?:dans |sur |de )?(?:la |les )?dates?\b/, 3], [/\bmauvaises? dates?\b/, 3], [/\bau lieu du \d/, 2], [/\bet non (?:le|du) \d/, 2],
      [/\bnouvelles? dates?\b/, 3], [/\bun jour (?:de )?(?:plus|moins|trop|avant|apres)\b/, 3], [/\b(?:dernier|premier) jour (?:a |de )?(?:annuler|supprimer|retirer|enlever)\b/, 3],
      [/\bdates?\b/, 1],
    ],
    nl: [
      [/\b(?:data|datum|periode|huurperiode) (?:graag )?(?:aanpassen|wijzigen|veranderen|verplaatsen|verzetten)\b/, 3], [/\b(?:een|1) dag (?:later|eerder|langer|korter|te lang|minder|meer)\b/, 3],
      [/\bverkeerde (?:datum|data|week)\b/, 3], [/\bmoet zijn\b/, 2], [/\bverplaatsen\b/, 2], [/\bnaar \d/, 1], [/\b(?:in plaats van|i\.?p\.?v\.?) \d/, 2],
      [/\bandere (?:datum|data|periode)\b/, 2], [/\bdatum\b/, 1], [/\bwijzig\w+\b/, 1],
    ],
    it: [[/\b(?:cambiare|modificare|spostare) (?:le |la )?dat[ae]\b/, 3], [/\bdate? (?:sbagliat|errat)\w+\b/, 3], [/\bun giorno (?:in )?(?:piu|meno|prima|dopo)\b/, 3]],
    es: [[/\b(?:cambiar|modificar) (?:las? |mis? )?fechas?\b/, 3], [/\bfechas? (?:equivocad|incorrect|erron)\w+\b/, 3], [/\bun dia (?:mas|menos|antes|despues)\b/, 3]],
  },

  VOUCHER_RESEND: {
    en: [
      [/\b(?:have|has|had)? ?(?:not|n'?t|never) (?:yet )?received (?:a|an|any|the|my|our)? ?(?:booking |order |email |e-mail )?confirmation\b/, 3],
      [/\bno confirmation (?:email|e-mail|mail)?\b/, 3], [/\bconfirmation (?:email|e-mail|mail) (?:has )?(?:not|never) (?:arrived|come|been received)\b/, 3],
      [/\b(?:re-?send|send (?:me|us)? ?(?:again|the|a|my|our)) (?:the |my |our |a )?(?:booking |order )?(?:confirmation|voucher|documents?|receipt|invoice)\b/, 3],
      [/\b(?:cannot|can'?t|unable to|could not|couldn'?t) (?:download|open|find|access) (?:the |my |our )?(?:voucher|confirmation|document|link|pdf)\b/, 3],
      [/\bvoucher\b/, 2], [/\b(?:lost|misplaced|deleted) (?:the |my |our )?(?:confirmation|voucher|email)\b/, 3], [/\bproof of (?:booking|payment|purchase)\b/, 2],
      [/\b(?:receipt|invoice) (?:for|of) (?:my|our|the) (?:booking|payment)\b/, 2], [/\bstill (?:have )?not received\b/, 2], [/\bnothing (?:in|arrived)\b/, 1], [/\bspam\b/, 1],
      [/\bconfirmation\b/, 1], [/\bbooking (?:reference|number|confirmation) (?:please|for)\b/, 1],
    ],
    de: [
      [/\b(?:keine|noch keine|nie eine) (?:buchungs)?bestatigung(?:smail)?\b/, 3], [/\bbuchungsbestatigung (?:nicht )?(?:erhalten|bekommen|angekommen)\b/, 3],
      [/\b(?:kann|konnte|kann ich) (?:die |den |das )?(?:buchungsbestatigung|voucher|gutschein|link|dokument|datei) nicht (?:herunterladen|offnen|finden)\b/, 3],
      [/\b(?:erneut|nochmal|noch einmal|nochmals) (?:zu)?(?:senden|schicken|zukommen)\b/, 3], [/\bzusenden\b/, 2], [/\bherunterladen\b/, 2], [/\bvoucher\b/, 2], [/\bgutschein\b/, 1],
      [/\b(?:rechnung|quittung|beleg|zahlungsbestatigung)\b/, 2], [/\berror\b/, 1], [/\bbestatigung\b/, 1],
    ],
    fr: [
      [/\b(?:pas|jamais|toujours pas) recu (?:de |le |la |ma |mon |votre )?(?:mail|e-?mail|courriel|confirmation|voucher|bon)\b/, 3], [/\bn'?(?:ai|avons) (?:pas |rien )recu\b/, 3],
      [/\bmail de confirmation\b/, 2], [/\brenvoyer\b/, 3], [/\bne retrouve (?:pas |plus )?(?:le |la |mon |ma )?(?:mail|confirmation|voucher|bon)\b/, 3],
      [/\b(?:impossible|n'?arrive pas) (?:de |a )?(?:telecharger|ouvrir)\b/, 3], [/\bvoucher\b/, 2], [/\bbon (?:de )?(?:reservation|location|echange)\b/, 2], [/\bfacture\b/, 2], [/\bjustificatif\b/, 2], [/\bconfirmation\b/, 1],
    ],
    nl: [
      [/\b(?:geen|nog geen|nooit een) (?:boekings)?bevestiging(?:smail)?\b/, 3], [/\bbevestiging (?:niet )?ontvangen\b/, 3], [/\bbevestigingsmail\b/, 2],
      [/\b(?:opnieuw|nogmaals|alsnog) (?:toe)?(?:sturen|zenden|mailen)\b/, 3], [/\b(?:kan|kon) (?:de |het )?(?:voucher|bevestiging|link|bestand) niet (?:downloaden|openen|vinden)\b/, 3], [/\bvoucher\b/, 2], [/\bfactuur\b/, 2], [/\bdownloaden\b/, 1],
    ],
    it: [[/\bnon (?:ho|abbiamo) ricevuto\b/, 3], [/\bconferma\b/, 1], [/\b(?:re)?inviare (?:di nuovo|nuovamente)?\b/, 2], [/\bvoucher\b/, 2], [/\bfattura\b/, 2]],
    es: [[/\bno (?:he|hemos) recibido\b/, 3], [/\bconfirmacion\b/, 1], [/\b(?:re)?enviar (?:de nuevo|otra vez)?\b/, 2], [/\bvoucher|bono\b/, 2], [/\bfactura\b/, 2]],
  },

  QUOTE: {
    en: [
      [/\b(?:a |the )?(?:rental |ski |price )?quot(?:e|ation)\b/, 3], [/\b(?:looking|would like|want|wish) to (?:rent|hire|book)\b/, 2], [/\b(?:we|i) (?:are|am) (?:a group|a family|coming|looking|planning|travel+ing|staying)\b/, 2],
      [/\bgroup of \d+\b/, 2], [/\b(?:how much|what) (?:would|does|do|will) (?:it|this|that) cost\b/, 3], [/\bprices? (?:for|of)\b/, 2], [/\b(?:do|can) you (?:offer|provide|do|have)\b/, 1],
      [/\b(?:beginner|intermediate|advanced|expert)s?\b/, 1], [/\b(?:age[sd]?|years old|yrs)\b/, 1], [/\b(?:best|cheapest|good) (?:price|deal|offer|rate)\b/, 2], [/\bavailab(?:le|ility)\b/, 1], [/\brent(?:al)? (?:skis?|equipment|gear|snowboard)\b/, 1],
    ],
    de: [
      [/\b(?:ein )?angebot\b/, 3], [/\banfrage\b/, 2], [/\b(?:was|wie viel|wieviel) (?:kostet|kosten|wurde|wurden)\b/, 3], [/\b(?:preis|preise|kosten) (?:fur|von)\b/, 2],
      [/\b(?:mochten|wurden) (?:wir|ich) (?:gerne )?(?:ski|skier|ausrustung|snowboard)? ?(?:ausleihen|mieten|leihen|buchen)\b/, 2], [/\b\d+ jahre\b/, 1], [/\b(?:anfanger|fortgeschritten\w*|profi)\b/, 1],
      [/\b(?:gruppe|familie) (?:von|mit) \d+\b/, 2], [/\bverfugbar\w*\b/, 1], [/\bkommenden (?:skiurlaub|urlaub|winter)\b/, 2],
    ],
    fr: [
      [/\b(?:un )?devis\b/, 3], [/\bdemande de (?:devis|prix|tarif)\b/, 3], [/\b(?:combien|quel (?:est le )?(?:prix|tarif|cout))\b/, 3], [/\btarifs?\b/, 2],
      [/\b(?:souhait\w+|voudr\w+|aimer\w+) (?:louer|reserver)\b/, 2], [/\bgroupe de \d+\b/, 2], [/\b\d+ ans\b/, 1], [/\b(?:debutant|intermediaire|confirme|expert)s?\b/, 1], [/\bprochain sejour\b/, 2], [/\bdisponib\w+\b/, 1],
    ],
    nl: [
      [/\b(?:een )?offerte\b/, 3], [/\bprijsopgave\b/, 3], [/\b(?:wat|hoeveel) kost\b/, 3], [/\bprijzen?\b/, 2], [/\b(?:willen|wil) (?:graag )?(?:ski'?s|materiaal|uitrusting)? ?(?:huren|reserveren)\b/, 2],
      [/\bgroep van \d+\b/, 2], [/\b\d+ jaar\b/, 1], [/\b(?:beginner|gemiddeld|gevorderd)\w*\b/, 1], [/\baankomende (?:skireis|skivakantie|wintersport)\b/, 2], [/\bbeschikbaar\w*\b/, 1],
    ],
    it: [[/\bpreventivo\b/, 3], [/\bquanto cost\w+\b/, 3], [/\bprezz[io]\b/, 2], [/\b(?:vorremmo|vorrei) (?:noleggiare|affittare|prenotare)\b/, 2], [/\bgruppo di \d+\b/, 2]],
    es: [[/\bpresupuesto\b/, 3], [/\bcuanto (?:cuesta|costaria|vale)\b/, 3], [/\bprecios?\b/, 2], [/\b(?:queremos|quisiera|quiero) (?:alquilar|reservar)\b/, 2], [/\bgrupo de \d+\b/, 2]],
  },

  REQUOTE: {
    en: [
      [/\b(?:add|include) (?:a |an |one |two |\d+ |the |some )?(?:pair of )?(?:helmets?|boots?|poles?|skis?|snowboard|insurance|protection|cover|damage|guaranty|safety|person|adult|child|skier|day)s?\b/, 3],
      [/\b(?:forgot|forgotten) to (?:add|book|include|order)\b/, 3], [/\b(?:can|could|is it possible to) (?:i|we)? ?add\b/, 2], [/\badd (?:it|this|that|them|these) to (?:my|our|the) (?:booking|order|reservation)\b/, 3],
      [/\b(?:extra|additional|another|one more|\d+ more) (?:days?|persons?|people|adults?|child(?:ren)?|skiers?|pair)\b/, 3], [/\bextend (?:the |my |our )?(?:rental|booking|hire)? ?(?:by|for|until|to)\b/, 3],
      [/\bupgrade\b/, 2], [/\bto my (?:existing|current) booking\b/, 2], [/\badd\b/, 1],
    ],
    de: [
      [/\bhinzufugen\b/, 3], [/\b(?:dazu|noch) (?:buchen|bestellen|nehmen|hinzu)\b/, 3], [/\bvergessen (?:zu )?(?:buchen|hinzu|mit)\b/, 3], [/\bverlanger\w+\b/, 3], [/\b(?:einen|zwei|\d+) tage? (?:mehr|langer|zusatzlich)\b/, 3],
      [/\b(?:zusatzlich\w*|weitere[nrs]?|noch ein\w*) (?:person|helm|skischuhe|schuhe|stocke|tag|versicherung)\w*\b/, 3], [/\bnachtraglich\b/, 2], [/\berganzen\b/, 2], [/\bupgrade\b/, 2],
    ],
    fr: [
      [/\b(?:r)?ajouter\b/, 3], [/\bajout\b/, 3], [/\b(?:ai|avons) oublie (?:de |d')?(?:reserver|ajouter|prendre|commander)\b/, 3], [/\bprolonger\b/, 3], [/\b(?:un|deux|\d+) jours? (?:de plus|supplementaires?|en plus)\b/, 3],
      [/\b(?:une|un) (?:personne|casque|paire) (?:de plus|supplementaire|en plus)\b/, 3], [/\bcompleter (?:ma|la) reservation\b/, 2], [/\bupgrade\b/, 2],
    ],
    nl: [
      [/\btoevoegen\b/, 3], [/\b(?:erbij|bij) (?:boeken|bestellen|nemen)\b/, 3], [/\bvergeten (?:te )?(?:boeken|toevoegen|reserveren)\b/, 3], [/\bverleng\w+\b/, 3], [/\b(?:een|twee|\d+) (?:dag|dagen|persoon|personen) (?:extra|erbij|langer|meer)\b/, 3], [/\bextra (?:dag|helm|schoenen|persoon)\w*\b/, 3],
    ],
    it: [[/\baggiungere\b/, 3], [/\bprolungare\b/, 3], [/\b(?:un|due|\d+) giorn[oi] in piu\b/, 3], [/\bdimenticato di\b/, 2]],
    es: [[/\banadir|agregar\b/, 3], [/\bprolongar|ampliar\b/, 3], [/\b(?:un|dos|\d+) dias? mas\b/, 3], [/\bolvid\w+\b/, 2]],
  },

  DUPLICATE_BOOKING: {
    en: [[/\b(?:double|duplicate|twice|two|2) (?:booking|bookings|booked|reservation|payment|charged|times)\b/, 3], [/\bbooked (?:it )?twice\b/, 3], [/\b(?:charged|paid|debited) (?:twice|two times|double|2x)\b/, 3], [/\bby (?:mistake|accident|error) .{0,30}(?:second|another|new) booking\b/, 3], [/\bsame (?:booking|equipment|dates) twice\b/, 3], [/\bduplicate\b/, 2]],
    de: [[/\bdoppel(?:t|te|ter)? ?(?:buchung|gebucht|bezahlt|abgebucht|belastet)\b/, 3], [/\bzwei ?mal (?:gebucht|bezahlt|abgebucht)\b/, 3], [/\bversehentlich (?:zwei|noch ein|eine zweite)\w*\b/, 3], [/\bdoppelt\b/, 2]],
    fr: [[/\b(?:double|deux) (?:reservations?|paiements?|fois)\b/, 3], [/\b(?:reserve|paye|debite|preleve) (?:deux fois|en double|2 fois)\b/, 3], [/\bdoublon\b/, 3], [/\bpar erreur .{0,30}(?:deuxieme|seconde|nouvelle) reservation\b/, 3], [/\ben double\b/, 2]],
    nl: [[/\bdubbel(?:e)? (?:boeking|geboekt|betaald|afgeschreven)\b/, 3], [/\btwee (?:keer|maal) (?:geboekt|betaald)\b/, 3], [/\bper ongeluk .{0,30}(?:tweede|nieuwe) boeking\b/, 3], [/\bdubbel\b/, 2]],
    it: [[/\bdoppi[ao] (?:prenotazione|pagamento|addebito)\b/, 3], [/\bdue volte\b/, 2]],
    es: [[/\bdoble (?:reserva|pago|cargo)\b/, 3], [/\bdos veces\b/, 2], [/\bduplicad\w+\b/, 3]],
  },

  DEPOT_SWITCH: {
    en: [[/\b(?:ski )?(?:depot|storage|lockers?|store (?:the|our|my) skis?|overnight)\b/, 3], [/\b(?:swap|switch|exchange|change) (?:the |my |our )?(?:skis?|model|equipment)\b/, 3], [/\b(?:specific|particular|certain) (?:ski |snowboard )?(?:model|brand)\b/, 3], [/\b(?:atomic|head|rossignol|volkl|salomon|stockli|nordica|fischer|k2|blizzard|elan|dynastar)\b/, 2], [/\b(?:length|size) \d{3} ?cm\b/, 2], [/\bmodel ?change\b/, 3], [/\b(?:leave|keep) (?:the |our |my )?skis? (?:at|in) the shop\b/, 3]],
    de: [[/\b(?:ski)?depot\b/, 3], [/\b(?:skier|ski) (?:im geschaft|im shop|im laden) (?:lassen|einstellen|lagern|deponieren)\b/, 3], [/\b(?:modell|ski) ?(?:wechsel|tausch|wechseln|tauschen)\b/, 3], [/\bbestimmte[ns]? (?:modell|ski|marke)\b/, 3], [/\b(?:atomic|head|rossignol|volkl|salomon|stockli|nordica|fischer|k2|blizzard|elan|redster|supershape|magnum)\b/, 2], [/\b(?:lange|in) \d{3} ?cm\b/, 2], [/\btesten\b/, 1], [/\bhabt ihr (?:den|die|das)\b/, 1]],
    fr: [[/\b(?:consigne|casiers?|depot) (?:a skis?)?\b/, 3], [/\blaisser (?:les|nos|mes) skis? (?:au|dans le) magasin\b/, 3], [/\b(?:changer|echanger) (?:de |les |mes )?(?:skis?|modele)\b/, 3], [/\bmodele (?:precis|particulier|specifique)\b/, 3], [/\b(?:atomic|head|rossignol|volkl|salomon|stockli|nordica|fischer|k2|blizzard|elan|dynastar)\b/, 2], [/\b\d{3} ?cm\b/, 1]],
    nl: [[/\b(?:ski)?depot\b/, 3], [/\b(?:ski'?s|materiaal) (?:in de winkel|achter)? ?(?:laten|opslaan|bewaren|stallen)\b/, 3], [/\b(?:wisselen|omruilen|ruilen) (?:van )?(?:ski'?s|model)\b/, 3], [/\bspecifiek\w* (?:model|merk)\b/, 3], [/\b(?:atomic|head|rossignol|volkl|salomon|stockli|nordica|fischer|k2|blizzard|elan)\b/, 2]],
    it: [[/\bdeposito\b/, 3], [/\bcambi\w+ (?:sci|modello)\b/, 3], [/\bmodello specifico\b/, 3]],
    es: [[/\b(?:guarda|consigna|deposito) ?(?:esquis)?\b/, 3], [/\bcambi\w+ (?:de )?(?:esquis|modelo)\b/, 3], [/\bmodelo (?:concreto|especifico)\b/, 3]],
  },

  PERSONAL_INFO: {
    en: [[/\b\d{2,3} ?(?:kg|kilos?)\b/, 2], [/\b\d{3} ?cm\b/, 1], [/\b(?:shoe|boot|foot) size\b/, 3], [/\b(?:height|weight)s?\b/, 2], [/\b(?:missing|update|correct|change|wrong) (?:the )?(?:skier |personal |fitting )?(?:details|information|data|measurements)\b/, 3], [/\b(?:ski(?:ing)? )?(?:level|ability)\b/, 1], [/\bdate of birth\b/, 2], [/\bnames? of the skiers?\b/, 3], [/\bchange (?:the |a )?name\b/, 2], [/\bsize\b/, 1]],
    de: [[/\b\d{2,3} ?(?:kg|kilo)\b/, 2], [/\b\d{3} ?cm\b/, 1], [/\bschuhgro(?:ss|s|ß)e\b/, 3], [/\b(?:gro(?:ss|ß)e|gewicht|korpergro\w+)\b/, 2], [/\b(?:daten|angaben|masse) (?:andern|korrigieren|erganzen|nachtragen|anpassen)\b/, 3], [/\bfahrkonnen\b/, 2], [/\bgeburtsdatum\b/, 2], [/\bnamen? (?:andern|korrigieren)\b/, 3], [/\bfalsche[ns]? (?:daten|gro\w+|gewicht|schuhgro\w+)\b/, 3]],
    fr: [[/\b\d{2,3} ?(?:kg|kilos?)\b/, 2], [/\b\d{3} ?cm\b/, 1], [/\b(?:pointure|taille de chaussure)s?\b/, 3], [/\b(?:tailles?|poids)\b/, 2], [/\b(?:modifier|corriger|completer|renseigner|changer) (?:les |mes |nos )?(?:informations|donnees|tailles|mesures|noms?)\b/, 3], [/\bniveau\b/, 1], [/\bdate de naissance\b/, 2], [/\bnoms? des skieurs\b/, 3]],
    nl: [[/\b\d{2,3} ?(?:kg|kilo)\b/, 2], [/\b\d{3} ?cm\b/, 1], [/\bschoenmaat\b/, 3], [/\b(?:lengte|gewicht|maat)\b/, 2], [/\b(?:gegevens|maten) (?:aanpassen|wijzigen|corrigeren|aanvullen|doorgeven)\b/, 3], [/\bgeboortedatum\b/, 2], [/\bnaam (?:aanpassen|wijzigen|veranderen)\b/, 3], [/\bniveau\b/, 1]],
    it: [[/\bnumero di scarp\w+\b/, 3], [/\b(?:altezza|peso)\b/, 2], [/\b\d{2,3} ?kg\b/, 2], [/\bdati (?:dei|degli) sciatori\b/, 3]],
    es: [[/\b(?:talla|numero) de (?:pie|bota|zapato)\b/, 3], [/\b(?:altura|peso|estatura)\b/, 2], [/\b\d{2,3} ?kg\b/, 2], [/\bdatos (?:de los|del) esquiador\w*\b/, 3]],
  },

  CHANGE_OF_SHOP: {
    en: [[/\b(?:change|switch|move|transfer|swap) (?:to |the |my |our |a )?(?:different |another |other |new )?(?:shop|store|rental shop|pick-?up (?:point|location)|location)\b/, 3], [/\b(?:wrong|different|another|other) (?:shop|store|resort|village|town)\b/, 3], [/\bcloser to (?:our|my|the) (?:hotel|apartment|accommodation|chalet)\b/, 3], [/\bpick(?: |-)?up (?:from|at|in) (?:a |the )?(?:different|other|another)\b/, 3], [/\bshop\b/, 1]],
    de: [[/\b(?:anderen|anderes|andere) (?:shop|geschaft|laden|verleih|station|abholort|abholstation)\b/, 3], [/\b(?:shop|geschaft|laden|verleih|abholort) (?:wechseln|andern|tauschen)\b/, 3], [/\b(?:falschen|falsches|falsche) (?:shop|geschaft|laden|ort|verleih)\b/, 3], [/\bnaher (?:an|bei|zu) (?:unserem|unserer|der|dem) (?:hotel|unterkunft|apartment)\b/, 3], [/\bumbuchen auf\b/, 2]],
    fr: [[/\btransfer\w+ (?:la |les |ma |notre )?reservations?\b/, 3], [/\btransfert\b/, 3], [/\bchang\w+ de magasin\b/, 3], [/\b(?:autre|mauvais) magasin\b/, 3], [/\bplus proche de (?:notre|l'|mon|la|du) (?:hotel|hebergement|residence|appartement|chalet)\b/, 3], [/\bmagasin\b/, 1]],
    nl: [[/\b(?:andere|verkeerde) (?:winkel|verhuurder|shop|locatie|afhaalpunt)\b/, 3], [/\b(?:winkel|shop|locatie) (?:wijzigen|veranderen|aanpassen|wisselen)\b/, 3], [/\bdichter bij (?:ons|onze|het) (?:hotel|appartement|accommodatie|verblijf)\b/, 3]],
    it: [[/\b(?:altro|diverso|sbagliato) negozio\b/, 3], [/\bcambiare negozio\b/, 3], [/\bpiu vicino (?:al|all'|alla) (?:hotel|albergo|appartamento)\b/, 3]],
    es: [[/\b(?:otra|otro|diferente|equivocad\w+) (?:tienda|local|punto de recogida)\b/, 3], [/\bcambiar de tienda\b/, 3], [/\bmas cerca (?:del|de la|de nuestro) (?:hotel|apartamento|alojamiento)\b/, 3]],
  },

  PAYMENT: {
    en: [[/\bpayment (?:failed|declined|did not go through|didn'?t work|error|problem|issue)\b/, 3], [/\b(?:card|credit card) (?:was )?(?:declined|refused|rejected|charged)\b/, 3], [/\b(?:have|has|had|was|were)? ?(?:not|n'?t) (?:been )?(?:charged|debited|taken|refunded)\b/, 3], [/\b(?:where is|still waiting for|when will i (?:get|receive)|have not received) (?:my |the |our )?refund\b/, 3], [/\brefund (?:has )?(?:not|never) (?:arrived|been received|come through)\b/, 3], [/\b(?:pay|paying) (?:the )?(?:balance|remaining|rest|deposit|down ?payment)\b/, 3], [/\b(?:charged|debited) (?:the )?(?:wrong|full|extra) amount\b/, 3], [/\bpayment link\b/, 3], [/\b(?:pay|payment|paid)\b/, 1], [/\brefund\b/, 1]],
    de: [[/\bzahlung (?:fehlgeschlagen|abgelehnt|nicht (?:moglich|funktioniert|durchgegangen)|problem)\b/, 3], [/\b(?:karte|kreditkarte) (?:wurde )?(?:abgelehnt|nicht akzeptiert|belastet)\b/, 3], [/\b(?:nicht|noch nicht|nie) (?:abgebucht|belastet|erstattet|zuruckerstattet|uberwiesen)\b/, 3], [/\b(?:wo bleibt|warte (?:noch )?auf|wann kommt) (?:die |meine |unsere )?(?:ruckerstattung|erstattung|ruckzahlung|gutschrift)\b/, 3], [/\b(?:rest|anzahlung|restbetrag|restzahlung) (?:bezahlen|zahlen|uberweisen)\b/, 3], [/\bzahlungslink\b/, 3], [/\b(?:doppelt|falsch|zu viel) (?:abgebucht|belastet|berechnet)\b/, 3], [/\b(?:zahlung|bezahl\w+|abgebucht)\b/, 1], [/\b(?:ruck)?erstattung\b/, 1]],
    fr: [[/\bpaiement (?:refuse|echoue|impossible|bloque|n'?a pas (?:fonctionne|abouti|marche)|probleme)\b/, 3], [/\bcarte (?:refusee|rejetee|debitee|bloquee)\b/, 3], [/\b(?:pas|toujours pas|jamais) (?:ete )?(?:debite|preleve|rembourse)\w*\b/, 3], [/\b(?:ou en est|j'?attends|quand (?:aurai|recevrai)) (?:le |mon |notre )?remboursement\b/, 3], [/\b(?:payer|regler) (?:le |la )?(?:solde|reste|acompte|restant)\b/, 3], [/\blien de paiement\b/, 3], [/\b(?:preleve|debite) (?:deux fois|en trop|un montant)\b/, 3], [/\b(?:paiement|paye|prelevement)\b/, 1], [/\bremboursement\b/, 1]],
    nl: [[/\bbetaling (?:mislukt|geweigerd|niet gelukt|niet doorgegaan|probleem)\b/, 3], [/\b(?:kaart|creditcard) (?:geweigerd|afgeschreven|geblokkeerd)\b/, 3], [/\b(?:niet|nog niet|nooit) (?:afgeschreven|terugbetaald|teruggestort|gestort)\b/, 3], [/\b(?:waar blijft|wacht (?:nog )?op|wanneer (?:krijg|ontvang)) (?:ik |wij )?(?:de |mijn |onze )?(?:terugbetaling|restitutie|refund)\b/, 3], [/\b(?:rest|restant|aanbetaling|restbedrag) betalen\b/, 3], [/\bbetaallink\b/, 3], [/\b(?:dubbel|verkeerd|te veel) (?:afgeschreven|betaald|in rekening)\b/, 3], [/\b(?:betaling|betaald|afgeschreven)\b/, 1], [/\b(?:terugbetaling|restitutie|bedrag)\b/, 1]],
    it: [[/\bpagamento (?:rifiutato|fallito|non (?:riuscito|andato))\b/, 3], [/\brimborso\b/, 2], [/\baddebit\w+\b/, 2], [/\bpagamento\b/, 1]],
    es: [[/\bpago (?:rechazado|fallido|no (?:realizado|procesado))\b/, 3], [/\breembolso\b/, 2], [/\bcobr\w+\b/, 2], [/\bpago\b/, 1]],
  },

  GENERAL_QUESTION: {
    en: [[/\b(?:stolen|theft|robbed|police (?:report)?)\b/, 3], [/\b(?:damaged|broken|snapped|cracked) (?:skis?|ski|board|pole|equipment|binding)\b/, 3], [/\b(?:insurance|guaranty|alpin ?guaranty|alpin ?safety|damage cover) (?:claim|case)\b/, 3], [/\bclaim\b/, 2], [/\bopening (?:hours|times)\b/, 3], [/\b(?:what time|when) (?:does|do|is|are|will) (?:the )?(?:shop|store) (?:open|close|opening|closing)\b/, 3], [/\bpick(?: |-)?up (?:the day before|on the evening|the evening before|in the afternoon)\b/, 3], [/\bcollect (?:the |our |my )?(?:equipment|skis|gear) (?:the day|the evening|on the) before\b/, 3], [/\b(?:what|which) (?:is|are) (?:included|covered)\b/, 2], [/\b(?:promo|promotion|discount|voucher) code\b/, 3], [/\b(?:7th|seventh) day (?:free|for free)\b/, 3], [/\b(?:cancellation|refund) policy\b/, 3], [/\b(?:deliver\w*|delivery) to (?:the |our |my )?(?:hotel|apartment|accommodation|chalet)\b/, 3], [/\b(?:how|where) (?:do|can|should) (?:i|we) (?:collect|pick up|return|find)\b/, 2], [/\bquestion\b/, 1]],
    de: [[/\b(?:gestohlen|geklaut|entwendet|diebstahl|polizei|anzeige)\b/, 3], [/\b(?:beschadigt|gebrochen|kaputt|defekt)\w*\b/, 2], [/\b(?:versicherung|garantie|guaranty|safety|schadensfall|schaden)\b/, 2], [/\boffnungszeiten\b/, 3], [/\b(?:wann|bis wann|ab wann) (?:hat|offnet|schliesst|schlie\w+|ist) (?:der |das |die )?(?:shop|laden|geschaft|verleih)\b/, 3], [/\b(?:am |ab )?(?:vortag|vorabend|abend vorher|tag vorher|tag davor) (?:abholen|abgeholt|holen)\b/, 3], [/\b(?:gutschein|rabatt|aktions|promo)-?code\b/, 3], [/\b7\.? tag (?:gratis|kostenlos|frei)\b/, 3], [/\b(?:storno|stornierungs)-?(?:bedingungen|regeln|richtlinien)\b/, 3], [/\blieferung (?:ins|zum|in die) (?:hotel|unterkunft|apartment)\b/, 3], [/\bfrage\b/, 1]],
    fr: [[/\b(?:vole|volee|vol|volés|police|plainte)\b/, 3], [/\b(?:casse|abime|endommage)\w*\b/, 2], [/\b(?:assurance|garantie|guaranty|safety|sinistre|dommage)\b/, 2], [/\bhoraires? (?:d'?ouverture)?\b/, 3], [/\b(?:a quelle heure|quand) (?:ouvre|ferme) (?:le )?magasin\b/, 3], [/\b(?:recuperer|retirer|prendre|chercher) (?:le materiel|les skis) (?:la veille|le soir d'avant|l'apres-midi)\b/, 3], [/\bla veille\b/, 2], [/\bcode (?:promo|promotionnel|de reduction|remise)\b/, 3], [/\b7e?m?e? jour (?:gratuit|offert)\b/, 3], [/\bconditions d'annulation\b/, 3], [/\blivraison (?:a l'|au |dans l')(?:hotel|hebergement|appartement)\b/, 3], [/\bquestion\b/, 1]],
    nl: [[/\b(?:gestolen|diefstal|politie|aangifte)\b/, 3], [/\b(?:beschadigd|kapot|gebroken)\b/, 2], [/\b(?:verzekering|garantie|guaranty|safety|schade)\b/, 2], [/\bopeningstijden\b/, 3], [/\b(?:hoe laat|wanneer) (?:gaat|is|sluit|opent) (?:de )?winkel\b/, 3], [/\b(?:de dag|de avond) (?:ervoor|van tevoren|voor) (?:ophalen|afhalen)\b/, 3], [/\b(?:korting|promo|actie)code\b/, 3], [/\b7e dag (?:gratis|vrij)\b/, 3], [/\bannuleringsvoorwaarden\b/, 3], [/\bbezorg\w+ (?:bij|naar|op) (?:het )?(?:hotel|appartement|accommodatie)\b/, 3], [/\bvraag\b/, 1]],
    it: [[/\b(?:rubat\w+|furto|polizia|denuncia)\b/, 3], [/\bassicurazione\b/, 2], [/\borari? (?:di apertura)?\b/, 3], [/\bcodice (?:sconto|promo)\b/, 3], [/\bdomanda\b/, 1]],
    es: [[/\b(?:robad\w+|robo|policia|denuncia)\b/, 3], [/\bseguro\b/, 2], [/\bhorarios?\b/, 3], [/\bcodigo (?:de )?(?:descuento|promocional)\b/, 3], [/\bpregunta\b/, 1]],
  },
};

const TOPICS = Object.keys(D);

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/\s+/g, ' ');
}

// Score every topic on the text. lang optional ('en','de','fr','nl','it','es'): when
// given, that language's rules count fully and the others at half weight — a German
// mail quoting an English confirmation must not be pulled by the English rules.
function scoreIntents(text, lang, opts) {
  opts = opts || {};
  const t = norm(text);
  const hasRef = opts.hasRef !== undefined ? !!opts.hasRef : /\bb[1-9a-hj-np-z]{5}\b/.test(t);
  const out = [];
  for (const topic of TOPICS) {
    let score = 0; const hits = []; const seen = new Set();
    for (const [l, rules] of Object.entries(D[topic])) {
      const f = (!lang || l === lang) ? 1 : 0.5;
      for (const [re, w] of rules) {
        const m = re.exec(t);
        if (!m) continue;
        // the same words matched by two languages' rules count once (numbers, brands, "voucher")
        if (seen.has(m[0])) continue;
        seen.add(m[0]);
        score += w * f; hits.push(l + ':' + m[0].slice(0, 40));
      }
    }
    if (score > 0) out.push({ topic, score, hits });
  }
  // Without a booking reference, measurements, brands, "add", dates and "two bookings" are far
  // more often part of a quote request than of a change to an existing booking.
  const q = out.find(x => x.topic === 'QUOTE');
  if (!hasRef && q && q.score >= 2) {
    for (const x of out) if (NEEDS_BOOKING.has(x.topic)) x.score *= 0.5;
  }
  for (const x of out) x.score = Math.round(x.score * 10) / 10;
  out.sort((a, b) => b.score - a.score);
  return out;
}
// Topics whose dictionary decision measured >= 84 % precision on the labeled corpus (dict/eval.mjs);
// only these may override the model. The others are hints and tie-breakers.
const STRONG_TOPICS = new Set(['CANCELLATION', 'CANCELLATION_AFTER', 'VOUCHER_RESEND', 'QUOTE']);
const NEEDS_BOOKING = new Set(['PERSONAL_INFO', 'DEPOT_SWITCH', 'REQUOTE', 'DATE_CHANGE', 'PARTIAL_CANCELLATION', 'DUPLICATE_BOOKING', 'CHANGE_OF_SHOP']);

// The decision: a topic, or null when the dictionary is not sure enough.
function decideIntent(text, lang, opts) {
  const s = scoreIntents(text, lang, opts);
  if (!s.length || s[0].score < MIN_SCORE) return { topic: null, scores: s };
  const margin = s.length > 1 ? s[0].score - s[1].score : s[0].score;
  if (margin < MIN_MARGIN) return { topic: null, scores: s, ambiguous: [s[0].topic, s[1].topic] };
  return { topic: s[0].topic, scores: s };
}

export { D, TOPICS, norm, scoreIntents, decideIntent, MIN_SCORE, MIN_MARGIN, STRONG_TOPICS };
export default { D, TOPICS, norm, scoreIntents, decideIntent, MIN_SCORE, MIN_MARGIN, STRONG_TOPICS };
