import type { SensitiveCategory } from "./sensitive.js";

// Jeux de mesure de la détection des données sensibles.
// DESIGN : écrit EN MÊME TEMPS que les règles (il a servi à les régler).
// HELD_OUT : écrit APRÈS avoir figé les règles, jamais utilisé pour les ajuster ;
// même auteur que les règles, donc biais possible : à compléter par des
// exemples réels (anonymisés) de l'organisation.

export type SensitiveCase = { text: string; expected: SensitiveCategory[] };

export const SENSITIVE_DESIGN: SensitiveCase[] = [
  // Identifiants valides (clé de contrôle correcte).
  { text: "Mon numéro de sécu est 1 85 05 78 006 084 91.", expected: ["nir"] },
  { text: "NIR du salarié : 290017511603554", expected: ["nir"] },
  { text: "Né en Corse : 2 78 02 2A 004 123 37", expected: ["nir"] },
  { text: "Virement sur FR76 3000 6000 0112 3456 7890 189 svp", expected: ["iban"] },
  { text: "IBAN fournisseur DE89370400440532013000", expected: ["iban"] },
  { text: "Paye avec la carte 4111 1111 1111 1111, exp 12/28", expected: ["card"] },
  { text: "CB : 5555-5555-5555-4444", expected: ["card"] },
  // Santé visant une personne.
  { text: "Julie Martin est en arrêt maladie pour dépression depuis lundi.", expected: ["health"] },
  { text: "Mon collègue a été diagnostiqué diabétique, comment adapter son poste ?", expected: ["health"] },
  { text: "Elle est enceinte de trois mois et demande un aménagement d'horaires.", expected: ["health"] },
  { text: "Rédige un mail pour M. Durand qui revient d'un mi-temps thérapeutique après sa chimiothérapie.", expected: ["health"] },
  { text: "Le salarié est reconnu RQTH, quelles obligations pour nous ?", expected: ["health"] },
  { text: "J'ai un traitement antidépresseur, puis-je conduire le véhicule de service ?", expected: ["health"] },
  // Légitimes : chiffres et santé SANS personne ni identifiant valide.
  { text: "Commande n° 4111 1111 1111 1112 livrée hier.", expected: [] },
  { text: "Référence dossier 1 85 05 78 006 084 92 (ancienne numérotation).", expected: [] },
  { text: "Le diabète touche plus de 4 millions de personnes en France.", expected: [] },
  { text: "Rédige la politique de prévention des risques psychosociaux de l'entreprise.", expected: [] },
  { text: "Branche l'enceinte Bluetooth dans la salle Orion.", expected: [] },
  { text: "Ce retard est un handicap pour le projet, il faut replanifier.", expected: [] },
  { text: "Facture FR-2026-0042 de 1 250 € TTC, échéance le 15/11.", expected: [] },
  { text: "Appelle le 06 12 34 56 78 pour la livraison.", expected: [] },
  { text: "Quels sont les congés pour un événement familial ?", expected: [] },
];

export const SENSITIVE_HELD_OUT: SensitiveCase[] = [
  { text: "Pour le remboursement, voici mon IBAN : FR76 3000 6000 0112 3456 7890 189.", expected: ["iban"] },
  { text: "numéro de sécurité sociale de l'intérimaire : 1690699350012 67", expected: ["nir"] },
  { text: "La carte de la société finit par 0005 : 3782 822463 10005", expected: ["card"] },
  { text: "Thomas Bernard a fait un AVC le week-end dernier, prévenir l'équipe ?", expected: ["health"] },
  { text: "Ma fille est hospitalisée, je dois poser des congés en urgence.", expected: ["health"] },
  { text: "Le candidat a mentionné une maladie chronique pendant l'entretien.", expected: ["health"] },
  { text: "Le médecin du travail a déclaré une inaptitude pour Mme Leroy.", expected: ["health"] },
  { text: "Son épilepsie l'empêche de travailler sur les machines.", expected: ["health"] },
  { text: "Compte-rendu de la réunion budget : +4 % sur la formation.", expected: [] },
  { text: "La sécurité sociale rembourse-t-elle les lunettes ?", expected: [] },
  { text: "Numéro de lot 4532 0151 1283 0366 à contrôler en entrepôt.", expected: [] },
  { text: "Ajoute une clause sur le handicap dans l'accord d'entreprise.", expected: [] },
  { text: "Quelle est la procédure en cas d'accident du travail ?", expected: [] },
  { text: "Code projet DE12 ABCD 1234 5678 90 pour la refacturation.", expected: [] },
  { text: "Prépare une note sur la mutuelle santé de l'entreprise.", expected: [] },
  { text: "Il faut un vaccin pour la mission au Brésil ? Je pars en mars.", expected: [] },
];
