# AIPD — Analyse d'impact relative à la protection des données (trame)

> **Brouillon technique** préparé par l'équipe produit. Le responsable de
> traitement (l'organisation qui déploie Snowfall) le complète, le valide avec
> son DPO, et le signe. Les cases « À compléter » ne peuvent pas être remplies
> par l'éditeur du logiciel.

Version : 0.1, 17 octobre 2026.

## 1. Pourquoi une AIPD

Le traitement combine plusieurs critères qui la rendent probable, au sens des
lignes directrices du CEPD et de la liste de la CNIL : usage innovant
(modèles d'IA génératifs), données potentiellement sensibles dans les
conversations et les documents, traitement à grande échelle possible.

## 2. Description du traitement

| | |
|---|---|
| Finalité | Assistant de travail : réponses aux questions des salariés, recherche dans les documents de l'organisation, agents spécialisés, outils (web, calcul, services métier) |
| Responsable de traitement | À compléter (l'organisation cliente) |
| Sous-traitant | À compléter (l'opérateur de la plateforme, s'il est distinct) |
| Personnes concernées | Membres de l'organisation ; personnes citées dans les conversations et documents |
| Base légale | À compléter (souvent : intérêt légitime, ou exécution du contrat de travail) |

### Données et durées de conservation

| Données | Contenu | Conservation (paramétrable) |
|---|---|---|
| Comptes | Identifiant, e-mail, rôle | Durée de l'appartenance à l'organisation |
| Conversations et réponses | Texte, pièces jointes, sources citées | Jusqu'à suppression par l'utilisateur ; supprimées au départ du membre |
| Bases de connaissances | Documents, passages, vecteurs | Jusqu'à suppression de la source ou de l'agent |
| Fichiers produits par le code | Images, tableaux | Avec la conversation ; orphelins purgés sous 24 h |
| Résumés de compaction | Résumé chiffré des échanges anciens | Avec la conversation |
| Traces des agents (Langfuse) | Étapes, durées, tokens ; contenu masqué, aucun pour le confidentiel | 30 jours |
| Journal d'audit | Événements de sécurité, sans contenu ni e-mail | 365 jours (90 minimum) |
| Consommation | Tokens et appels d'outils par membre et par mois | À compléter |
| Réflexion du modèle | Affichée, jamais enregistrée | Aucune |
| Conversations temporaires | Comme une conversation, hors historique et sans contenu dans les traces | 24 h |
| Mémoire de l'utilisateur | Faits courts qu'il a demandé de retenir (désactivée par défaut) | Jusqu'à effacement par l'utilisateur ; supprimée à son départ |
| Liens de partage | Instantané chiffré d'une conversation, lisible dans l'organisation | 1, 7 ou 30 jours (révocable) |
| Bibliothèque de prompts | Textes de prompts, privés ou partagés | Jusqu'à suppression par l'auteur |
| Retours 👍👎 | Note, commentaire chiffré ; taux par agent agrégé (5 personnes au moins) | Avec la réponse notée |
| Connexions aux outils externes (OAuth) | Jetons de l'utilisateur, chiffrés, lisibles par lui seul | Jusqu'à déconnexion, échec de renouvellement, suppression du connecteur ou départ |
| Dictée | Audio transcrit par un service local | Aucune : jamais conservé |

### Destinataires et flux

| Destinataire | Données | Condition |
|---|---|---|
| Fournisseurs d'IA (Mistral, OpenAI, Anthropic, Google) | Message, historique récent, extraits des documents | Seulement les fournisseurs autorisés par l'organisation ; **jamais** pour une base confidentielle (modèle local exigé) |
| Moteurs de recherche (via SearXNG) | Requête de recherche formulée par l'agent | Si l'organisation active la recherche web ; jamais en confidentiel |
| Serveurs MCP | Arguments des appels d'outils | Serveurs approuvés par un administrateur ; écritures validées par l'utilisateur ; jamais en confidentiel |
| Modèles locaux (embeddings, reclassement, éventuellement génération) | Textes | Sur la plateforme : rien ne sort |
| OCR local | Documents numérisés | Sur la plateforme, conteneur sans réseau : rien ne sort |
| Voix et images locales | Audio dicté, texte lu, descriptions d'images | Services auto-hébergés : rien ne sort |
| Amélioration des agents (👎 partagé) | Question posée et commentaire, sans la réponse ni le nom | Consentement explicite (case non cochée) ; visibles par l'auteur de l'agent et les administrateurs ; chiffrés ; effacés au retrait du 👎, à la suppression du compte ou de l'agent. Mesures et propositions envoyées au juge (modèle autorisé de l'organisation, local si base confidentielle) |
| Atelier d'entraînement (administrateurs) | Exemples rédigés par les administrateurs (aucune donnée personnelle attendue, consigne affichée) | Service local sans réseau ; chiffrés ; jamais tirés des conversations |
| Détection des données sensibles | Message et documents joints, analysés sur la plateforme (aucun envoi) | Seules les catégories détectées sont tracées ; la conversation est alors répondue par un modèle local |
| Agents planifiés | Consigne de l'utilisateur, noms des documents ajoutés à la base de l'agent | Mêmes destinataires qu'un message de l'utilisateur (modèle autorisé) ; privés à leur auteur ; supprimés avec son compte ou l'agent |
| Service de décision local (routage des modèles) | Question posée (4 000 caractères au plus) | Conteneur sans réseau, rien conservé ni journalisé ; le modèle choisi reste un fournisseur autorisé |
| Outils externes en mode OAuth | Arguments des appels, au nom de l'utilisateur | Serveur approuvé par un administrateur ; connexion choisie par l'utilisateur |
| Fournisseur d'IA de la réponse | Mémoire de l'utilisateur (s'il l'a activée) | Jamais en conversation temporaire ni confidentielle |

Transferts hors UE : à compléter selon les fournisseurs autorisés (localisation,
clauses contractuelles types, garanties complémentaires).

## 3. Nécessité et proportionnalité

- **Minimisation** : historique limité, budget de tokens, seuls les extraits
  pertinents des documents sont envoyés, réflexion jamais conservée.
- **Contrôle par l'organisation** : fournisseurs, outils, quotas, MCP et
  recherche web activés explicitement.
- **Transparence pour l'utilisateur** : étapes de l'agent visibles, sources
  citées, validation de chaque écriture, modèle utilisé affiché.
- **Droits des personnes** : suppression des conversations par l'utilisateur ;
  suppression au départ d'un membre ; export de toutes ses données (Mon compte →
  Mes données : droit d'accès et portabilité) ; mémoire visible et effaçable,
  désactivée tant qu'il ne l'a pas activée ; conversation temporaire pour ce qui
  ne doit pas être conservé.

## 4. Risques pour les personnes

| Risque | Origine | Mesures | Gravité / vraisemblance résiduelles |
|---|---|---|---|
| Accès illégitime aux conversations | Faille, erreur de configuration, compte volé | Chiffrement par organisation, RLS, MFA obligatoire, audit | À évaluer |
| Divulgation à un fournisseur d'IA | Envoi de données personnelles dans un message | Liste blanche, modèles locaux pour le confidentiel, contrats (DPA, non-conservation) | À évaluer |
| Détournement de l'agent (injection) | Document ou page piégés | Contenus balisés, validation humaine des écritures, anti-exfiltration | À évaluer |
| Décision fondée sur une réponse erronée | Hallucination | Sources citées, avertissement dans l'interface, évaluations | À évaluer |
| Surveillance des salariés | Lecture des usages | Audit sans contenu ; consommation agrégée ; traces masquées et courtes ; mémoire illisible par les administrateurs ; taux par agent seulement à partir de 5 personnes | À évaluer |
| Profilage par la mémoire | Faits accumulés sur une personne | Désactivée par défaut, chaque ajout validé par l'utilisateur, liste visible et effaçable, jamais alimentée par un document | À évaluer |
| Diffusion trop large d'une conversation | Lien de partage transmis | Lecture réservée à l'organisation, durée limitée, révocation, audit des ouvertures, refus pour le confidentiel | À évaluer |

## 5. Plan d'action

| Action | Responsable | Échéance |
|---|---|---|
| Signer les DPA des fournisseurs d'IA autorisés, demander la non-conservation | À compléter | |
| Fixer la base légale et informer les salariés | À compléter | |
| Ajouter l'export des données d'un utilisateur | Équipe produit | Phase 3 |
| Mémoire à long terme : désactivée par défaut, visible et effaçable (décision du 16/10) | Équipe produit | Phase 3 |
| Test d'intrusion externe | À compléter | |
| Revue annuelle de cette AIPD | DPO | |
