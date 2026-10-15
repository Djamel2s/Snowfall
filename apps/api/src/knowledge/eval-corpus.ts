// Jeu d'évaluation de la recherche (données fictives) : documents structurés
// et questions formulées comme un utilisateur, avec le passage attendu.
// Plusieurs questions ne partagent presque aucun mot avec la réponse, ou ne
// se comprennent qu'avec le titre de la section : c'est ce que mesure le jeu.

export type EvalDocument = { name: string; text: string };
export type EvalQuestion = {
  question: string;
  /** Extrait qui doit figurer dans un des passages renvoyés. */
  expected: string;
  /** Échange précédent : question de suivi qui n'a de sens qu'avec lui. */
  history?: string;
};

export const evalDocuments: EvalDocument[] = [
  {
    name: "Politique RH Polaris.md",
    text: `# Politique RH Polaris

## Congés payés
Chaque salarié acquiert 2,5 jours ouvrables par mois de travail effectif, soit 30 jours par an.
Les demandes sont validées par le manager au moins quinze jours avant le départ.

## Télétravail
Le télétravail est possible trois jours par semaine pour les fonctions éligibles.
Une indemnité forfaitaire de 30 € par mois couvre les frais de connexion.

## Recrutement
Les CV des candidats non retenus sont conservés deux ans après le dernier contact, puis supprimés.
Les entretiens se déroulent en deux étapes : un échange avec les RH puis un cas pratique.

## Stagiaires
La gratification est versée dès le premier mois et s'élève à 4,35 € de l'heure.
Les stagiaires bénéficient du même accès au restaurant d'entreprise que les salariés.`,
  },
  {
    name: "Charte informatique.md",
    text: `# Charte informatique

## Mots de passe
Les mots de passe comportent au moins 14 caractères et sont uniques pour chaque service.
Le gestionnaire de mots de passe fourni par l'entreprise est obligatoire.

## Postes de travail
Le chiffrement intégral du disque est activé sur tous les ordinateurs portables.
Les mises à jour de sécurité sont installées dans un délai de sept jours.

## Signalement
Tout incident est déclaré au SOC dans l'heure par le formulaire interne ou au 4242.
Ne jamais éteindre une machine compromise : la débrancher du réseau.`,
  },
  {
    name: "Procédure de sauvegarde.md",
    text: `# Procédure de sauvegarde

## Fréquence
Les bases de production sont sauvegardées toutes les quatre heures, les fichiers chaque nuit.

## Restauration
Un test de restauration complet est réalisé chaque trimestre et consigné dans le registre.
L'objectif de reprise est fixé à huit heures, la perte de données maximale à quatre heures.

## Conservation
Les sauvegardes quotidiennes sont gardées trente-cinq jours, les mensuelles un an.`,
  },
  {
    name: "Note de frais.md",
    text: `# Note de frais

## Déplacements
Le train est privilégié pour tout trajet de moins de quatre heures.
Les billets d'avion en classe affaires sont réservés aux vols de plus de six heures.

## Repas
Le plafond de remboursement d'un repas est de 25 € en France et 40 € à l'étranger.

## Délais
Les justificatifs sont transmis dans les trente jours, le remboursement intervient sous dix jours.`,
  },
  {
    name: "Sécurité des locaux.md",
    text: `# Sécurité des locaux

## Badges
Le badge est personnel ; sa perte est signalée à l'accueil le jour même.
Les visiteurs sont accompagnés en permanence et portent un badge rouge.

## Horaires
Le bâtiment est accessible de 7 h à 21 h ; au-delà, une autorisation du responsable de site est nécessaire.`,
  },
  {
    name: "RGPD - registre.md",
    text: `# Registre des traitements

## Paie
Base légale : obligation légale. Données : identité, coordonnées bancaires, rémunération.
Durée de conservation : cinq ans après la fin du contrat.

## Vidéosurveillance
Les images sont conservées trente jours au maximum, sauf procédure judiciaire.
Seuls deux agents habilités peuvent les consulter.`,
  },
];

export const evalQuestions: EvalQuestion[] = [
  { question: "Combien de jours de vacances par an ?", expected: "30 jours par an" },
  { question: "Je peux travailler de chez moi combien de jours ?", expected: "trois jours par semaine" },
  { question: "Combien de temps garde-t-on les CV ?", expected: "conservés deux ans" },
  { question: "Quelle est la rémunération d'un stagiaire ?", expected: "4,35 €" },
  { question: "Longueur minimale d'un mot de passe ?", expected: "14 caractères" },
  { question: "Les ordinateurs sont-ils chiffrés ?", expected: "chiffrement intégral" },
  { question: "Que faire en cas de cyberattaque sur mon PC ?", expected: "débrancher du réseau" },
  { question: "À quelle fréquence sauvegarde-t-on la base de données ?", expected: "toutes les quatre heures" },
  { question: "Tous les combien teste-t-on une restauration ?", expected: "chaque trimestre" },
  { question: "RTO et RPO ?", expected: "huit heures" },
  { question: "Combien de temps garde-t-on une sauvegarde mensuelle ?", expected: "les mensuelles un an" },
  { question: "Puis-je prendre l'avion en business ?", expected: "classe affaires" },
  { question: "Plafond pour un déjeuner à l'étranger ?", expected: "40 € à l'étranger" },
  { question: "Sous combien de jours suis-je remboursé ?", expected: "sous dix jours" },
  { question: "J'ai perdu mon badge, que faire ?", expected: "signalée à l'accueil" },
  { question: "Peut-on venir au bureau le soir tard ?", expected: "de 7 h à 21 h" },
  { question: "Durée de conservation des bulletins de salaire ?", expected: "cinq ans après la fin du contrat" },
  { question: "Combien de temps sont gardées les images des caméras ?", expected: "trente jours au maximum" },
  { question: "Qui valide les congés ?", expected: "validées par le manager" },
  { question: "Y a-t-il une prime pour le télétravail ?", expected: "30 € par mois" },
  // Questions de suivi : sans l'échange précédent, elles sont ambiguës.
  { question: "Et ils mangent où ?", history: "Quelle gratification pour un stagiaire ?", expected: "même accès au restaurant" },
  { question: "Et celles de chaque jour ?", history: "Combien de temps garde-t-on les sauvegardes mensuelles ?", expected: "trente-cinq jours" },
  { question: "Et ailleurs ?", history: "Quel est le plafond de remboursement d'un repas en France ?", expected: "40 € à l'étranger" },
  { question: "Dans quel délai ?", history: "Les mises à jour de sécurité des postes sont-elles obligatoires ?", expected: "sept jours" },
  { question: "Et ensuite ?", history: "Comment se passe la première étape des entretiens de recrutement ?", expected: "cas pratique" },
];
