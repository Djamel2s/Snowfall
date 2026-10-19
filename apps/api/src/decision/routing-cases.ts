// Jeux étiquetés pour le routage des modèles : « simple » (un petit modèle
// suffit) ou « complexe » (raisonnement, rédaction longue, code, analyse de
// documents). Deux jeux séparés : « train » sert à entraîner, « test » est
// tenu à l'écart et ne sert qu'à mesurer.

export type RoutingLabel = "simple" | "complexe";
export type RoutingCase = { text: string; label: RoutingLabel };

export const ROUTING_TRAIN: RoutingCase[] = [
  { text: "Bonjour !", label: "simple" },
  { text: "Merci beaucoup pour ton aide.", label: "simple" },
  { text: "Quelle heure est-il à Tokyo quand il est midi à Paris ?", label: "simple" },
  { text: "Traduis « bonne journée » en anglais.", label: "simple" },
  { text: "Combien de jours de congés payés avons-nous ?", label: "simple" },
  { text: "Quel est le numéro du support informatique ?", label: "simple" },
  { text: "Donne-moi un synonyme de « rapide ».", label: "simple" },
  { text: "C'est quoi un KPI ?", label: "simple" },
  { text: "Corrige l'orthographe : « je vous envoie les document demander ».", label: "simple" },
  { text: "Peux-tu reformuler cette phrase plus poliment : « envoie-moi le fichier ».", label: "simple" },
  { text: "What is the capital of Canada?", label: "simple" },
  { text: "Thanks, that's perfect.", label: "simple" },
  { text: "Où se trouve la salle de réunion Everest ?", label: "simple" },
  { text: "Rappelle-moi l'adresse du siège.", label: "simple" },
  { text: "Quelle est la date limite des notes de frais ce mois-ci ?", label: "simple" },
  { text: "Analyse ces trois offres fournisseurs et recommande la meilleure en justifiant sur le coût total, les délais et les risques.", label: "complexe" },
  { text: "Rédige une note de cadrage de deux pages pour le projet de migration vers le cloud, avec objectifs, risques et planning.", label: "complexe" },
  { text: "Écris une fonction Python qui fusionne deux fichiers CSV par identifiant client et signale les doublons.", label: "complexe" },
  { text: "Compare la politique de télétravail actuelle avec la nouvelle proposition et liste les impacts pour chaque service.", label: "complexe" },
  { text: "Prépare un plan de formation sur six mois pour une équipe de dix commerciaux débutants.", label: "complexe" },
  { text: "Explique pourquoi notre marge a baissé au troisième trimestre à partir des chiffres joints, et propose trois actions.", label: "complexe" },
  { text: "Construis un tableau comparatif des cinq outils de ticketing du marché selon le prix, l'intégration et la sécurité.", label: "complexe" },
  { text: "Draft a detailed incident report for yesterday's outage, including timeline, root cause and remediation plan.", label: "complexe" },
  { text: "Résume ce contrat de 40 pages en points clés, puis repère les clauses à risque pour nous.", label: "complexe" },
  { text: "Calcule le retour sur investissement du projet sur cinq ans avec ces hypothèses et fais une analyse de sensibilité.", label: "complexe" },
  { text: "Conçois l'architecture d'une API de réservation de salles, avec modèle de données et règles d'accès.", label: "complexe" },
  { text: "Rédige la réponse à cet appel d'offres en reprenant nos références et en argumentant sur chaque critère.", label: "complexe" },
  { text: "Trouve l'erreur dans ce script SQL qui renvoie des doublons et propose une version corrigée et optimisée.", label: "complexe" },
  { text: "Élabore une stratégie de communication de crise pour un rappel produit, par public et par canal.", label: "complexe" },
  { text: "Évalue les risques RGPD de ce nouveau traitement et propose les mesures à mettre en place.", label: "complexe" },
];

/** Tenu à l'écart : écrit avant toute mesure, jamais utilisé pour entraîner ni régler. */
export const ROUTING_TEST: RoutingCase[] = [
  { text: "Salut, ça va ?", label: "simple" },
  { text: "Quel est le mot de passe du wifi invités ?", label: "simple" },
  { text: "Combien font 15 % de 240 ?", label: "simple" },
  { text: "Qui est le responsable du service achats ?", label: "simple" },
  { text: "Écris « réunion reportée à jeudi » en espagnol.", label: "simple" },
  { text: "Le parking est-il ouvert le samedi ?", label: "simple" },
  { text: "Quelle est l'extension d'un fichier Excel ?", label: "simple" },
  { text: "Ok merci, à demain.", label: "simple" },
  { text: "How many days are in a leap year?", label: "simple" },
  { text: "Donne-moi le lien vers l'intranet RH.", label: "simple" },
  { text: "Peux-tu me dire combien de jours de télétravail sont autorisés ?", label: "simple" },
  { text: "Mets cette phrase au pluriel : « le client a validé la commande ».", label: "simple" },
  { text: "Établis un budget prévisionnel détaillé pour l'ouverture d'une agence à Lyon, poste par poste, avec trois scénarios.", label: "complexe" },
  { text: "Analyse les retours clients du dernier trimestre, regroupe-les par thème et priorise les améliorations produit.", label: "complexe" },
  { text: "Écris un script qui surveille un dossier, convertit les PDF reçus en texte et envoie une alerte en cas d'échec.", label: "complexe" },
  { text: "Rédige une politique interne d'usage de l'IA générative, avec règles, exemples et sanctions.", label: "complexe" },
  { text: "Compare nos conditions générales avec celles de nos deux concurrents et propose des modifications argumentées.", label: "complexe" },
  { text: "Write a migration plan from our monolith to microservices with phases, risks and rollback strategy.", label: "complexe" },
  { text: "Prépare l'ordre du jour et un dossier de préparation complet pour le comité de direction de lundi sur la réorganisation.", label: "complexe" },
  { text: "Démontre que la nouvelle grille tarifaire reste rentable si les volumes baissent de 20 %, chiffres à l'appui.", label: "complexe" },
  { text: "Identifie les incohérences entre le cahier des charges et le devis du prestataire, point par point.", label: "complexe" },
  { text: "Construis un modèle de scoring des leads à partir de ces critères et explique comment le valider.", label: "complexe" },
  { text: "Peux-tu m'aider à structurer ma présentation de 30 minutes sur la stratégie 2027, avec un plan et les messages clés ?", label: "complexe" },
  { text: "Explique en détail comment fonctionne notre processus de clôture comptable et où se situent les goulets d'étranglement.", label: "complexe" },
];
