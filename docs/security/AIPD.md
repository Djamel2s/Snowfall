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

### Destinataires et flux

| Destinataire | Données | Condition |
|---|---|---|
| Fournisseurs d'IA (Mistral, OpenAI, Anthropic, Google) | Message, historique récent, extraits des documents | Seulement les fournisseurs autorisés par l'organisation ; **jamais** pour une base confidentielle (modèle local exigé) |
| Moteurs de recherche (via SearXNG) | Requête de recherche formulée par l'agent | Si l'organisation active la recherche web ; jamais en confidentiel |
| Serveurs MCP | Arguments des appels d'outils | Serveurs approuvés par un administrateur ; écritures validées par l'utilisateur ; jamais en confidentiel |
| Modèles locaux (embeddings, reclassement, éventuellement génération) | Textes | Sur la plateforme : rien ne sort |

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
  suppression au départ d'un membre. **À prévoir** : export des données de
  l'utilisateur (droit d'accès et portabilité).

## 4. Risques pour les personnes

| Risque | Origine | Mesures | Gravité / vraisemblance résiduelles |
|---|---|---|---|
| Accès illégitime aux conversations | Faille, erreur de configuration, compte volé | Chiffrement par organisation, RLS, MFA obligatoire, audit | À évaluer |
| Divulgation à un fournisseur d'IA | Envoi de données personnelles dans un message | Liste blanche, modèles locaux pour le confidentiel, contrats (DPA, non-conservation) | À évaluer |
| Détournement de l'agent (injection) | Document ou page piégés | Contenus balisés, validation humaine des écritures, anti-exfiltration | À évaluer |
| Décision fondée sur une réponse erronée | Hallucination | Sources citées, avertissement dans l'interface, évaluations | À évaluer |
| Surveillance des salariés | Lecture des usages | Audit sans contenu ; consommation agrégée ; traces masquées et courtes | À évaluer |

## 5. Plan d'action

| Action | Responsable | Échéance |
|---|---|---|
| Signer les DPA des fournisseurs d'IA autorisés, demander la non-conservation | À compléter | |
| Fixer la base légale et informer les salariés | À compléter | |
| Ajouter l'export des données d'un utilisateur | Équipe produit | Phase 3 |
| Mémoire à long terme : désactivée par défaut, visible et effaçable (décision du 16/10) | Équipe produit | Phase 3 |
| Test d'intrusion externe | À compléter | |
| Revue annuelle de cette AIPD | DPO | |
