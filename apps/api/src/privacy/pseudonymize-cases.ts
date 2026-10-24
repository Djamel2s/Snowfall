// Jeux de mesure de la pseudonymisation. « personal » : ce qui ne doit JAMAIS
// partir ; « keep » : mots ordinaires qui doivent rester (sinon la réponse se dégrade).
// DESIGN a servi à écrire les règles ; HELD_OUT a été écrit après, jamais pour les
// régler (même auteur : à compléter par des exemples réels anonymisés).

export type PseudonymizeCase = { text: string; personal: string[]; keep: string[] };

export const PSEUDONYMIZE_DESIGN: PseudonymizeCase[] = [
  { text: "Écris à julie.martin@polaris.fr pour la réunion Orion.", personal: ["julie.martin@polaris.fr"], keep: ["Orion"] },
  { text: "Rappelle Julie Martin au 06 12 34 56 78 avant jeudi.", personal: ["Julie Martin", "06 12 34 56 78"], keep: ["jeudi"] },
  { text: "M. Durand habite 12 rue des Lilas, 75011 Paris.", personal: ["Durand", "12 rue des Lilas", "75011 Paris"], keep: ["M."] },
  { text: "Mme Leroy a validé le budget ; Leroy part en congé lundi.", personal: ["Leroy"], keep: ["budget", "lundi"] },
  { text: "Son numéro : +33 6 12 34 56 78, ou au bureau +44 20 7946 0958.", personal: ["+33 6 12 34 56 78", "+44 20 7946 0958"], keep: [] },
  { text: "Thomas a envoyé le rapport Mistral à Sophie Bernard.", personal: ["Thomas", "Sophie Bernard"], keep: ["Mistral", "rapport"] },
  { text: "Le projet Orion démarre à Lyon avec l'équipe Atlas.", personal: [], keep: ["Orion", "Lyon", "Atlas"] },
  { text: "La salle Pasteur est réservée pour le comité de direction.", personal: [], keep: ["Pasteur", "comité"] },
  { text: "Rédige une note pour Dr Nguyen sur le protocole de sécurité.", personal: ["Nguyen"], keep: ["protocole"] },
];

export const PSEUDONYMIZE_HELD_OUT: PseudonymizeCase[] = [
  { text: "Merci de contacter Pierre Dubois (pierre.dubois@acme.com) pour le devis.", personal: ["Pierre Dubois", "pierre.dubois@acme.com"], keep: ["devis"] },
  { text: "Livraison au 3 bis avenue Victor Hugo, 69003 Lyon, chez Mme Garcia.", personal: ["3 bis avenue Victor Hugo", "69003 Lyon", "Garcia"], keep: ["Livraison"] },
  { text: "Camille Petit et Hugo Moreau présenteront la démo Atlas vendredi.", personal: ["Camille Petit", "Hugo Moreau"], keep: ["Atlas", "vendredi"] },
  { text: "Appelez le standard au 01.45.67.89.10 ou écrivez à contact@acme.com.", personal: ["01.45.67.89.10", "contact@acme.com"], keep: ["standard"] },
  // Nom de famille seul, sans civilité ni prénom : cas difficile pour des règles.
  { text: "Le client Renault a signé ; Moreau suivra le dossier.", personal: ["Moreau"], keep: ["Renault", "dossier"] },
  { text: "Kevin a perdu son badge, Kevin doit passer à l'accueil.", personal: ["Kevin"], keep: ["badge", "accueil"] },
  { text: "Organise un point avec Maître Lefebvre au sujet du bail.", personal: ["Lefebvre"], keep: ["bail"] },
  { text: "La migration vers Postgres 17 est prévue pour la version Orion 2.", personal: [], keep: ["Postgres", "Orion"] },
  { text: "Envoyez la facture à Nadia (nadia@atelier-b.fr) et à M. Fontaine.", personal: ["Nadia", "nadia@atelier-b.fr", "Fontaine"], keep: ["facture"] },
  { text: "Le centre Paris La Défense ferme à 19 h le samedi.", personal: [], keep: ["Paris", "Défense", "samedi"] },
];
