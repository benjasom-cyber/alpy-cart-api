/**
 * POST /api/find-nearest-shop
 *
 * CE FICHIER NE CONTIENT PLUS DE LOGIQUE — ET C'EST VOULU.
 *
 * Jusqu'au 11 septembre 2026, la logique existait en DEUX exemplaires : ici, et
 * dans _find-nearest-shop.js (que /api/support?action=find-nearest-shop sert).
 * Les deux copies avaient divergé sans que personne le voie :
 *
 *   - la copie servie ici appelait l'ANCIENNE API Google Places, fermée aux
 *     nouveaux projets Google Cloud depuis mars 2025 ;
 *   - la copie du module avait, elle, la nouvelle API, un meilleur étiquetage
 *     des résultats, et le garde-fou hitMatches() qui empêche un géocodeur de
 *     répondre "Les chalets du Belvédère" à une demande "Les Chalets du Forum"
 *     (ticket 581986).
 *
 * Corriger un défaut dans l'une ne corrigeait rien dans l'autre. Une règle du
 * type « penser à modifier les deux » n'aurait fait que déplacer le problème :
 * la seule vraie correction est qu'il n'y ait plus qu'une source.
 *
 * Toute modification se fait donc dans _find-nearest-shop.js, et elle vaut
 * immédiatement pour les deux chemins d'appel. Vérifié le 11 septembre 2026 :
 * les deux répondaient à l'identique sur resolve (Pinzolo), resolve ambigu
 * (Courchevel) et rank (Hotel Mont Blanc, Chamonix) avant le remplacement.
 */

export { handler as default } from './_find-nearest-shop.js';
export { handler } from './_find-nearest-shop.js';
