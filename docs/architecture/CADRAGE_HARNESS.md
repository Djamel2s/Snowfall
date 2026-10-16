# Cadrage — Harness d'agents, parité LibreChat et observabilité (Langfuse)

Statut : **validé le 2026-10-16** (décisions en fin de section 7).

## 1. Objectif

Faire de Snowfall une plateforme d'agents au niveau de l'état de l'art, en
reprenant les fonctionnalités de LibreChat, **sans renoncer au niveau de
sécurité actuel** (chiffrement par organisation, RLS, sorties contrôlées,
audit, bases confidentielles).

Le « harness » est la boucle qui pilote le modèle : il lui donne des outils,
exécute ceux qu'il demande, renvoie les résultats, et recommence jusqu'à la
réponse finale, en tenant le contexte, les coûts, les autorisations et les
traces.

## 2. Point de départ

| Déjà dans Snowfall | Manque |
|---|---|
| Multi-fournisseurs (Mistral, OpenAI, Anthropic, Google, local) | Boucle d'agent avec outils |
| Agents : instructions, modèle, avatar, base de connaissances | Outils (web, code, MCP, API, images…) |
| RAG hybride évalué, reformulation, reclassement, citations | RAG appelé par l'agent quand il en a besoin |
| Pièces jointes (documents, images) | OCR, audio, vidéo |
| Modifier, régénérer, arrêter, rechercher | Branches de conversation, artifacts, partage |
| Projets, i18n, SSO, quotas, administration | Mémoire, bibliothèque de prompts, presets |
| Audit, métriques, chiffrement, antivirus, proxy de sortie | Traces des agents (Langfuse), évaluations en ligne |

## 3. Le moteur (harness) visé

### 3.1 Boucle d'agent

- **Appels d'outils** natifs de chaque fournisseur, en parallèle quand le modèle
  en demande plusieurs, avec diffusion en direct des étapes (« recherche dans la
  base… », « exécution du code… »).
- **Limites par exécution** : nombre d'étapes, tokens, durée, coût ; arrêt propre
  et message clair quand une limite est atteinte.
- **Exécution durable** : une réponse longue survit à une déconnexion (reprise du
  flux), grâce aux points de reprise de LangGraph, déjà utilisé, stockés chiffrés
  en base.
- **Validation humaine** : un outil sensible (envoi, écriture, dépense) met la
  boucle en pause et attend l'accord de l'utilisateur dans l'interface.
- **Sous-agents et passages de relais** : un agent peut confier une tâche à un
  autre agent (chaîne d'agents, comme les « agent chains » de LibreChat).

### 3.2 Contexte

- **Cache de prompt** chez les fournisseurs qui le proposent (Anthropic, OpenAI,
  Google, Mistral) : moins cher et plus rapide sur les longues conversations.
- **Compaction** : au-delà d'un budget, les anciens échanges sont résumés au lieu
  d'être tronqués à 20 tours.
- **Raisonnement visible** (« thinking ») pour les modèles qui le proposent,
  repliable dans l'interface, jamais stocké en clair.
- **Sorties structurées** (JSON validé) pour les outils et les intégrations.

### 3.3 RAG « agentique »

La base de connaissances devient un outil : l'agent décide de chercher, reformule,
cherche plusieurs fois si besoin, et cite. La recherche automatique actuelle
reste disponible pour les modèles sans appels d'outils.

### 3.4 Observabilité (Langfuse auto-hébergé)

- Instrumentation au standard **OpenTelemetry** (conventions GenAI) : une trace par
  réponse, avec les étapes, les outils, les tokens, la latence et le coût.
  L'outil peut être changé plus tard sans réécrire le code.
- **Langfuse auto-hébergé** sur le réseau interne (PostgreSQL, ClickHouse, Redis,
  stockage objet) : rien ne sort.
- **Évaluations** : jeux de test (dont le jeu RAG existant), notes des
  utilisateurs (pouce haut ou bas), évaluations automatiques échantillonnées.

## 4. Parité LibreChat

Taille : **S** pour quelques jours, **M** pour une à deux semaines, **L** pour plus.

| Fonction | Ce que c'est | Taille | Priorité proposée |
|---|---|---|---|
| Recherche web | Recherche + lecture de pages, citations | M | P1 |
| Interpréteur de code | Exécution Python et autres, fichiers produits, graphiques | L | P1 |
| MCP | Brancher des serveurs d'outils standard (Drive, Jira, bases…) | L | P1 |
| Actions (API OpenAPI) | Appeler une API métier décrite par un schéma | M | P2 |
| Artifacts | Rendu à côté du chat : HTML, React, Mermaid, SVG, documents | M | P1 |
| Branches de conversation | Explorer plusieurs suites depuis un message | M | P1 |
| Partage de conversation | Lien en lecture, interne à l'organisation | S | P1 |
| Export et import | Markdown, PDF, JSON ; import ChatGPT ou LibreChat | S | P2 |
| Bibliothèque de prompts | Prompts réutilisables à variables, commandes « / » | S | P2 |
| Presets | Modèle, paramètres et instructions mémorisés | S | P2 |
| Paramètres du modèle | Température, longueur, effort de raisonnement | S | P2 |
| Mémoire | Faits retenus sur l'utilisateur, visibles et effaçables | M | P2 |
| Conversation temporaire | Rien n'est conservé | S | P2 |
| Favoris et étiquettes | Ranger les conversations | S | P3 |
| Comparaison de modèles | Deux modèles côte à côte sur la même question | M | P3 |
| Génération d'images | Image depuis un texte (fournisseur ou local) | M | P3 |
| Voix | Dictée et lecture (Whisper et Piper locaux) | M | P3 |
| OCR | PDF scannés et images dans les pièces jointes et la base | M | P2 |
| Audio et vidéo dans la base | Transcription locale (whisper.cpp) | M | P3 |
| Catalogue d'agents | Agents partagés, droits fins, duplication | M | P2 |
| API d'agents | Exposer un agent en API compatible OpenAI | M | P3 |

## 5. Sécurité, outil par outil

Règle commune : **tout résultat d'outil est une donnée non fiable**. Il est balisé
comme tel, il ne peut ni élargir les droits ni déclencher seul un outil sensible,
et il est analysé (taille, antivirus pour les fichiers). Chaque appel est tracé
dans l'audit, sans son contenu.

| Outil | Risques | Mesures |
|---|---|---|
| Recherche web | Injection de prompt par les pages, exfiltration par URL | Passage par le proxy de sortie, liste de domaines par organisation, contenu balisé, pas de lien cliquable généré à partir de données |
| Interpréteur de code | Évasion, minage, attaque réseau, fuite de fichiers | Micro-VM ou gVisor éphémère, sans réseau par défaut, CPU, mémoire et durée bornés, fichiers analysés par l'antivirus, aucun secret dans l'environnement |
| MCP | Serveur malveillant, outil qui change de comportement, vol de jetons | Serveurs approuvés par l'admin uniquement, liste d'outils figée et empreinte vérifiée, jetons OAuth par utilisateur chiffrés dans le KMS, validation humaine pour les écritures |
| Actions (API) | SSRF, fuite de secrets, actions destructrices | Récupération sécurisée existante, secrets dans le KMS, méthodes autorisées par action, validation humaine hors lecture |
| Artifacts | Script exécuté dans l'application | Iframe isolée (sandbox, origine distincte, CSP stricte), aucun accès aux cookies ni à l'API |
| Partage | Fuite hors de l'organisation | Lien interne authentifié, expiration, révocation, interdit pour les bases confidentielles |
| Mémoire | Données personnelles conservées à l'insu | Visible et effaçable par l'utilisateur, chiffrée, désactivable par l'organisation, incluse dans l'export RGPD |
| Génération d'images et voix | Contenu envoyé à un tiers | Fournisseurs autorisés par l'organisation, modèles locaux pour le confidentiel |
| Bases confidentielles | Fuite vers un modèle externe | Règle actuelle étendue à tous les outils : agent et outils locaux uniquement |
| Traces (Langfuse) | Copie des données sensibles | Hébergé en interne, masquage des données personnelles, bases confidentielles jamais tracées en clair, conservation limitée, accès réservé aux administrateurs |

**Modèle d'autorisation des outils** : l'organisation choisit les outils
disponibles, l'auteur de l'agent choisit parmi eux, et l'utilisateur valide les
actions sensibles. Les quotas couvrent aussi le coût des outils.

## 6. Plan proposé

| Phase | Contenu | Livrable vérifiable |
|---|---|---|
| **1. Socle** | Boucle d'outils, registre et autorisations, RAG agentique, limites, validation humaine, exécution durable, cache de prompt, compaction, raisonnement visible, OpenTelemetry et Langfuse | Un agent qui cherche dans sa base, s'arrête à ses limites, et dont chaque étape est visible dans Langfuse |
| **2. Outils clés** | Recherche web, artifacts, interpréteur de code isolé, MCP (serveurs approuvés) | Tests d'injection de prompt et d'évasion passés |
| **3. Confort LibreChat** | Branches, partage, export et import, prompts, presets, paramètres, mémoire, conversation temporaire, OCR, catalogue d'agents | Parité fonctionnelle vérifiée fonction par fonction |
| **4. Multimodal et ouverture** | Images, voix, audio et vidéo dans la base, comparaison, API d'agents, actions OpenAPI | Selon la priorité métier |

Chaque phase garde les exigences actuelles : tests automatisés, aucune régression
sur l'évaluation RAG, documentation de sécurité et d'exploitation mises à jour.

## 7. Décisions à prendre

1. **Priorités** : valider ou modifier la colonne « Priorité » de la section 4.
2. **Interpréteur de code** : sandbox auto-hébergée (gVisor ou Firecracker, plus
   sûre et souveraine, plus lourde) ou service externe (plus simple, mais le code
   et les fichiers sortent) ?
3. **MCP** : serveurs distants seulement (approuvés par l'admin), ou aussi des
   serveurs locaux lancés par la plateforme ?
4. **Recherche web** : quel moteur ? Auto-hébergé (SearXNG) ou API (Brave,
   Bing…) : l'un est souverain mais moins bon, l'autre envoie les requêtes à
   un tiers.
5. **Langfuse** : confirmer l'auto-hébergement, et la durée de conservation des
   traces (proposition : 30 jours).
6. **Mémoire** : activée par défaut ou sur demande de l'utilisateur ?
7. **Validation humaine** : quelles actions l'exigent par défaut (proposition :
   toute écriture ou envoi vers l'extérieur) ?
8. **Matériel** : GPU disponible en production ? Il conditionne le reclassement,
   la transcription, la voix et les modèles locaux plus gros.

### Décisions prises (2026-10-16)

| # | Décision |
|---|---|
| 1 | Priorités de la section 4 retenues telles quelles |
| 2 | Interpréteur de code : **sandbox auto-hébergée** (micro-VM éphémère, sans réseau) |
| 3 | MCP : serveurs distants approuvés par l'admin uniquement (pas de processus locaux lancés par la plateforme) |
| 4 | Recherche web : **SearXNG auto-hébergé uniquement** (via le proxy de sortie) |
| 5 | Langfuse auto-hébergé, traces conservées 30 jours |
| 6 | Mémoire : **désactivée par défaut**, activée par l'utilisateur, visible et effaçable |
| 7 | Validation humaine par défaut pour toute écriture ou tout envoi vers l'extérieur |
| 8 | **GPU disponible en production** : configurations GPU par défaut (TEI CUDA, transcription, voix, modèles locaux) |

Le statut du document passe à : **validé, phase 1 à lancer**.

## 8. Hors périmètre de ce chantier

Pilotage d'un ordinateur ou d'un navigateur par l'agent (« computer use »),
agents autonomes planifiés sans utilisateur, fine-tuning de modèles.
