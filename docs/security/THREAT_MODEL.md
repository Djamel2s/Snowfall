# Modèle de menaces — plateforme d'agents Snowfall

Statut : version 1, 17 octobre 2026. À revoir à chaque nouvel outil, nouveau
flux de données ou nouveau fournisseur.
Méthode : actifs → frontières de confiance → menaces (STRIDE) par composant →
mesures → risque résiduel → preuve. Les contrôles sont décrits dans
[SECURITY_BASELINE.md](SECURITY_BASELINE.md) §11.

## 1. Actifs

| Actif | Classification | Où |
|---|---|---|
| Conversations, pièces jointes, bases de connaissances | Confidentiel (parfois restreint : bases « confidentielles ») | PostgreSQL, chiffré par organisation |
| Clés (DEK par organisation, KEK du KMS), secrets de session | Restreint | OpenBao / Vault, fichiers secrets |
| Jetons des serveurs MCP (organisation et personnels OAuth) | Restreint | PostgreSQL, chiffré ; jetons personnels lisibles par leur seul titulaire |
| Identités et rôles | Confidentiel | Keycloak, `organization_members` |
| Traces des agents | Confidentiel (masqué) | Langfuse interne, 30 jours |
| Journal d'audit | Interne, intégrité critique | `audit_events` (append-only), SIEM |
| Disponibilité et budget (tokens, outils) | — | Quotas, limites par réponse |

## 2. Acteurs et frontières de confiance

```
 Utilisateur ──HTTPS──► nginx ──► API (BFF) ──► PostgreSQL (RLS) · KMS
   (navigateur)                     │
                                    ├──► Fournisseurs d'IA (externes)      ◄─ frontière : données qui sortent
                                    ├──► Proxy de sortie ──► Internet      ◄─ frontière : web, MCP, liens
                                    ├──► Bac à sable (socket, sans réseau) ◄─ frontière : code non fiable
                                    └──► Langfuse interne
 Contenu non fiable qui ENTRE dans le contexte du modèle : documents, pages web,
 résultats d'outils, réponses MCP, texte des autres membres (agents partagés).
```

| Acteur | Intention supposée |
|---|---|
| Membre malveillant d'une organisation | Lire les données d'un autre membre, d'une autre organisation, ou dépasser les quotas |
| Attaquant extérieur sans compte | Prendre une session, contourner l'authentification |
| Auteur d'un contenu piégé (document, page web, ticket relayé par MCP) | Détourner l'agent : faire écrire, faire sortir des données, faire mentir |
| Serveur MCP compromis ou malveillant | Changer ses outils après approbation, injecter des consignes, voler des données envoyées en arguments |
| Code généré par le modèle (sous influence) | S'échapper du bac à sable, attaquer le réseau, persister |
| Fournisseur d'IA | Conserver ou réutiliser les données envoyées (risque contractuel) |
| Administrateur de l'organisation (compte volé) | Ouvrir un outil dangereux, brancher un serveur MCP hostile |

## 3. Menaces par composant

Légende risque résiduel : **F** faible, **M** moyen, **É** élevé.

### 3.1 Identité, sessions, isolation

| Menace (STRIDE) | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Vol de session (S) | BFF : aucun jeton dans le navigateur, cookie `__Host-` HttpOnly SameSite=Strict, révocation côté Keycloak et back-channel | F | tests d'auth, essai Keycloak réel |
| CSRF (T) | `Origin` vérifié sur toute écriture + SameSite | F | `routes.test.ts` |
| Accès à une autre organisation (I) | RLS `FORCE` + filtres explicites + clés étrangères composites | F | tests d'intégration PostgreSQL |
| Élévation de rôle (E) | Changements de rôle par fonctions SECURITY DEFINER bornées | F | `workspace.integration.test.ts` |

### 3.2 Boucle d'agent et contenu non fiable (injection de prompt)

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Consigne cachée dans un document, une page, un résultat (T, E) | Balisage de données non fiables, nettoyage répété des balises, règles de la plateforme avant les instructions de l'agent, aucun outil accordé par le contenu | **F** pour l'exfiltration : règle de deux (contenu externe + données internes → tout appel sortant à valider), fondée sur la provenance, indépendante du texte. **M** pour le reste : la détection heuristique ne voit pas une attaque reformulée (0/12 sur le jeu v2) ; un document interne piégé peut orienter le premier appel sortant | `neutralize.test.ts`, `injection.test.ts`, `scripts/injection-holdout.ts`, 13 cas `securite-*` du banc |
| Écriture déclenchée par un contenu (T) | Validation humaine de chaque écriture, aperçu exact après validation des arguments | F | `approval.test.ts`, `securite-document-piege` |
| Exfiltration par adresse construite (I) | `read_webpage` limité aux adresses de la recherche ou tapées par l'utilisateur ; images jamais chargées dans les réponses | F | `web-tools.test.ts`, `securite-page-exfiltration` |
| Réponse mensongère (« c'est enregistré ») (R) | Règle anti-fausse affirmation dans le prompt, étapes visibles | M | cas `outils-refus`, `outils-sans-outil` |
| Emballement (coût, boucle) (D) | Étapes, appels par étape, budget de tokens, durée maximale, quotas d'outils | F | `agent-loop.test.ts`, `runs.routes.test.ts` |
| Données confidentielles vers l'extérieur (I) | Base confidentielle : modèle local exigé, ni web, ni MCP, aucun contenu tracé | F | `knowledge.routes.test.ts` |

### 3.3 Interpréteur de code

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Sortie réseau, attaque de l'API (I, E) | Aucun réseau, socket réservé au groupe de l'API | F | batterie d'attaques (CI) |
| Évasion vers l'hôte (E) | gVisor exigé en production, conteneur durci, 4 capacités | F (si gVisor vérifié sur l'hôte) | refus de démarrer sans gVisor ; vérification sur l'hôte à faire |
| Fuite entre exécutions ou utilisateurs (I) | Un utilisateur par emplacement, dossiers privés, `/tmp` fermé, tout tué en fin d'exécution | F | batterie d'attaques |
| Épuisement (D) | rlimits, délai, 2 emplacements, refus « occupé » | F | batterie d'attaques |
| Fichier produit dangereux (T) | Types autorisés, antivirus, SVG jamais affiché | F | `code-tool.test.ts` |

### 3.4 MCP

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Rug pull (outil changé après approbation) (T) | Empreinte de ce que l'admin a examiné, revérifiée à chaque réponse | F | `mcp.test.ts` |
| Description ou résultat piégé (T, E) | Description et paramètres montrés à l'examen, écriture validée par l'utilisateur, résultat balisé et tronqué | M (même limite que 3.2) | `mcp.test.ts`, test de bout en bout |
| SSRF vers le réseau interne (I) | HTTPS public, proxy obligatoire en production, liste de domaines, contrôle DNS sans proxy | F | tests d'adresses, config refusée sans proxy |
| Vol du jeton (I) | Chiffré, jamais renvoyé ni journalisé | F | test « jamais le jeton » |
| Action attribuée à tort sur le service distant (R) | Mode OAuth : chaque appel avec le jeton de l'utilisateur ; audit côté Snowfall | F en mode OAuth ; **M** en mode jeton partagé | `runs.routes.test.ts` (OAuth) |
| Vol ou rejeu de la connexion OAuth (S, I) | PKCE S256, state haché lié à l'utilisateur et à usage unique, indicateur de ressource, émetteur vérifié, retour par une page du même site | F | `oauth.test.ts`, test de bout en bout, intégration PostgreSQL |
| Jeton d'un autre utilisateur ou d'une autre organisation (E) | RLS propriétaire imposée, clés étrangères composites (serveur, organisation) | F | `connections.integration.test.ts` |
| Spécification OpenAPI piégée (T, I) | Fournie par l'admin et figée, références externes refusées, hôte final contrôlé, paramètres encodés, pas de redirection | F | `openapi.test.ts` |

### 3.4 bis Sous-agents, voix, images

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Escalade par délégation (E) | Outils du sous-agent = intersection avec ceux de l'appelant, profondeur 2, écritures et sorties validées par l'utilisateur (« pour le compte de »), exposition héritée (règle de deux) | F | `runs.routes.test.ts` (« Équipes d'agents ») |
| Écriture rejouée à la reprise (T) | Chaque sous-agent a son fil durable (`runId~clé`), effacé avec le run parent seulement | F | `runs.integration.test.ts` (sous-fils) |
| Équipe qui épuise les ressources (D) | Budget de tokens commun à l'équipe, 15 min par délégation, quota vérifié avant | M : un sous-agent gourmand prive les autres | tests d'équipe |
| Fuite du confidentiel par un spécialiste (I) | Refus si contexte ou base confidentiels et modèle externe, audité | F | test « base confidentielle » |
| Fichier audio ou image piégé (T) | Signature vérifiée, taille bornée, antivirus pour les images, rien d'exécuté | F | `audio.test.ts`, `image-tool.test.ts` |
| Écoute par un artifact (I) | Micro autorisé pour l'application seule, bloqué dans les artifacts | F | en-têtes nginx |

### 3.4 ter Routage des modèles (service de décision)

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Question confiée à un tiers (I) | Service local, sans réseau, socket réservé au groupe de l'API, rien journalisé | F | `decision_test.py` (CI) |
| Modèle de décision substitué (T) | Révision figée, empreintes SHA-256 vérifiées au build, formats exécutables refusés | F | `fetch_model.py` |
| Routage vers un modèle non autorisé (E) | Modèles publiés et fournisseurs autorisés vérifiés à l'enregistrement puis à chaque usage | F | `routes.test.ts`, `runs.routes.test.ts` (routage) |
| Réponse du service hostile ou absente (D) | Taille bornée, 3 s, repli sur l'heuristique | F | `routing.test.ts` |
| Qualité dégradée (question complexe jugée simple) | « complexe » si l'heuristique ou le modèle le dit ; mesure rejouée en CI | M : 2/24 complexes manqués | mesure tenue à l'écart |

### 3.4 quater Amélioration continue des agents

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Question d'un utilisateur exposée sans accord (I) | Partage sur case décochée par défaut, sans réponse ni nom ; refusé en temporaire ou confidentiel ; retrait = effacement | F | `runs.routes.test.ts` (« Amélioration continue »), `quality.integration.test.ts` |
| Cas piégé qui glisse une consigne dans les instructions (T, E) | Cas balisés comme données, consigne de ne rien recopier, proposition lue en entier et appliquée par l'auteur seulement | M : l'auteur doit relire | `improve.test.ts` (cas piégé) |
| Score gonflé par surapprentissage (T) | Un cas sur trois tenu à l'écart de l'optimiseur ; toute régression refuse | M : peu de cas, juge LLM | `improve.test.ts` |
| Proposition substituée à l'application (T) | Seule la proposition mesurée par le serveur s'applique, une fois, si l'agent n'a pas changé | F | tests de route |
| Coût incontrôlé (D) | Auteur ou admin, 30 cas, une amélioration à la fois, 10 min, quota avant chaque appel | F | tests de route |

### 3.4 quinquies Atelier d'entraînement et agents planifiés

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Entraînement sur des données personnelles (I) | Exemples écrits par les administrateurs seulement, jamais tirés des conversations ; chiffrés | M : dépend de ce qu'ils saisissent (consigne affichée) | revue, `workshop.integration.test.ts` |
| Décideur dégradé déployé (T) | Mesure sur la part de test figée ; déployable seulement si meilleur ET aucune question complexe perdue ; contrainte en base | M : part de test réutilisée | `workshop.test.ts`, `decision_test.py` |
| Tête substituée ou d'une autre révision (T) | Tête chiffrée, immuable ; le service refuse une autre révision ou une forme invalide | F | `decision_test.py` |
| Tâche planifiée qui agit sans personne (E) | Même route qu'un message ; écritures en attente de l'auteur, puis refus | F | `runs.routes.test.ts` (« Agents planifiés ») |
| Identité interne forgée (S) | Jeton aléatoire 256 bits, usage unique, 30 s, en mémoire ; en-tête effacé par nginx | F | test « en-tête interne forgé » |
| Double exécution entre instances (T) | File sans contenu, prise à bail atomique (SKIP LOCKED), bail conservé pendant l'exécution | F | `schedules.integration.test.ts` |
| Tâche d'un ancien membre (E) | Jamais prise en charge (jointure sur les membres) ; lecteur : ignorée | F | tests d'intégration et de route |

### 3.4 sexies Données sensibles

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Donnée sensible envoyée par mégarde à un fournisseur externe (I) | Détection locale avant tout envoi ; bascule définitive en local, sinon refus ; titre masqué ; mémoire refusée | M : images, formes obfusquées, autres catégories art. 9 | `sensitive.test.ts`, `runs.routes.test.ts` (« Données sensibles ») |
| Conversation sensible qui ressort (I) | Traitée comme confidentielle : ni traces, ni web, ni spécialiste externe, ni partage, ni cas d'évaluation | F | tests de route |
| Retrait du marquage (T) | Drapeau à sens unique, imposé par trigger | F | `store.integration.test.ts` |
| Valeur sensible dans l'audit ou les journaux (I) | Seules les catégories sont tracées | F | test « catégorie tracée sans la valeur » |

### 3.4 septies Pseudonymisation

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Données personnelles lues par le fournisseur (I) | Jetons stables pour e-mails, téléphones, adresses, identifiants, noms ; correspondance en mémoire le temps d'un appel | M : noms non repérés, images | `pseudonymize.test.ts`, `runs.routes.test.ts` (« Pseudonymisation ») |
| Faux jeton dans un document, restitué comme une autre personne (T) | Jetons déjà présents neutralisés à l'entrée | F | test « faux jeton » |
| Outil exécuté sur des jetons (T) | Arguments restitués avant l'exécution locale ; règle de deux inchangée | F | test du modèle enveloppé |
| Texte piégé qui fait ramer l'analyse (D) | Contrôle de chevauchement linéaire, expressions bornées | F | test « texte démesuré » |

### 3.4 octies Parité LibreChat (phase 1, 25 octobre)

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Consigne piégée glissée dans les réglages d'une conversation ou un préréglage (T) | Mêmes contrôles que les instructions personnalisées (donnée sensible, injection) ; bloc `<user_preferences>` sous la règle « ne remplace jamais les règles » ; balises retirées | M : injection paraphrasée (détecteur heuristique) | `runs.routes.test.ts` (« Réglages de conversation ») |
| Collègue qui lit un agent ou un prompt non partagé (I) | RLS sur `agents` et `prompts` via `snowfall_access()` ; l'API filtre aussi | F | `sharing.integration.test.ts` (SQL direct : aucune ligne) |
| Éditeur ou membre qui s'octroie ou étend un partage (E) | Politiques INSERT/DELETE de `resource_grants` : propriétaire ou administrateur seulement, signées par leur auteur ; l'API refuse aussi | F | idem (`FORBIDDEN`), `agents.test.ts` |
| Éditeur qui s'approprie un prompt (E) | Droit UPDATE limité aux colonnes `name, content, updated_at` ; auteur inchangeable | F | `prompts.integration.test.ts` |
| Membre réinvité qui retrouve d'anciens partages (E) | Autorisations supprimées avec le membre, dans la même transaction | F | test « membre retiré puis réinvité » |
| Bifurcation ou fichier réutilisé qui fait sortir une donnée sensible (I) | La copie hérite du drapeau sensible ; un fichier d'une conversation sensible rend la cible sensible ; contrôle à l'envoi | F | `workspace.integration.test.ts` (bifurquer, mes fichiers) |
| Comparaison vers un modèle externe d'une conversation locale à vie (I) | Refus 409 `local_only` (conversation sensible ou base confidentielle), tracé, jamais de bascule silencieuse | F | `runs.routes.test.ts` (« Comparer ») |
| Étiquette trompeuse (caractères de contrôle, bidi) (S) | Caractères de contrôle et de format refusés ; étiquettes chiffrées | F | test « archive et étiquettes » |
| Export qui contourne la CSP (T) | Export texte, impression et canevas faits dans le navigateur, sans bibliothèque de capture ni style injecté | F | `export.spec.ts`, `rendering.spec.ts` |

### 3.4 nonies Compétences des agents (25 octobre)

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Compétence partagée piégée qui détourne tous les agents qui l'utilisent (T) | Refus des consignes déguisées à l'enregistrement ; c'est l'auteur de l'agent qui choisit ses compétences ; historique des versions (qui a changé quoi) ; garde d'injection sur le résultat de l'outil | M : consigne paraphrasée (détecteur heuristique) ; un éditeur autorisé reste de confiance | `runs.routes.test.ts` (« Compétences »), `skills.integration.test.ts` |
| Compétence lue par quelqu'un qui ne devrait pas (I) | RLS : auteur, autorisation, ou agent visible qui l'utilise ; chargement limité aux compétences de l'agent | F | test « à travers un agent » (retrait de l'accès) |
| Membre qui confie à son agent la compétence d'un autre pour la lire (E) | Politique d'insertion d'`agent_skills` : il faut posséder la compétence ou y être autorisé | F | idem (`rejects`) |
| Donnée sensible d'une compétence envoyée à un modèle externe (I) | Donnée sensible seulement dans une compétence confidentielle ; jamais au catalogue d'un modèle externe ; agent forcé en local, même en changeant seulement de modèle | F | test « compétence confidentielle » |
| Fichier de référence malveillant (T) | Antivirus, texte extrait seulement, 10 fichiers, résultat tronqué et balisé non fiable | F | test « enregistrement » |
| Script de compétence hostile (E, I, D) — *scripts, 25 octobre* | Python seulement, exécuté dans le bac à sable (sans réseau, utilisateur dédié, limites CPU/mémoire/processus, gVisor en production), jamais sur l'API ; seulement si l'agent a « Exécuter du code » ; arguments en liste (aucun shell) ; fichiers de la compétence sous `skill/`, chemins validés (ni `..`, ni absolu, ni caché) ; fichiers produits passés à l'antivirus | F | `attack_test.py` (8 contrôles « compétence »), `runs.routes.test.ts` (« script de compétence ») |
| Sortie de script qui détourne l'agent (T) | Comptée non fiable (règle de deux) ; garde d'injection sur le résultat | M (comme tout contenu externe) | `exposure.test.ts` |
| Script qui contourne le quota de code (D) — *revue du 25 octobre* | Même compteur que `run_code` : plafond par réponse (5) et quota mensuel de l'organisation. Avant la revue, un script n'était compté dans aucun quota | F | test « script de compétence » (2ᵉ exécution refusée et tracée) |
| Secret laissé dans un script (I) | Même détecteur que les références : refusé hors compétence confidentielle | F | test « import zip » |
| Modèle binaire piégé ou volé (T, I) — *modèles, 25 octobre* | Formats reconnus à leur contenu (DOCX, XLSX, PDF, PNG, JPEG), 2 Mio au plus, antivirus ; original chiffré (contrainte en base, rotation des clés), lisible seulement à travers un agent qui a la compétence, jamais envoyé au modèle ; cellules d'un classeur contrôlées (données sensibles) | M : une image ou un PDF scanné ne sont pas lus (pas de contrôle des données sensibles) | `files.test.ts`, `skills.integration.test.ts` (« modèle binaire »), `rotation.integration.test.ts` |
| Script qui récupère des fichiers hors de la conversation (I, E) | Pièces jointes cherchées par leur nom dans CETTE conversation seulement (messages et message en cours), jamais dans « Mes fichiers » ; copiées sous `inputs/` (noms rendus sûrs, jamais exécutées, jamais à la racine) ; 5 au plus | F | `runs.routes.test.ts` (`../../etc/passwd` refusé), `files.test.ts`, `attack_test.py` |

### 3.4 decies Connecteurs et import de compétences (25 octobre)

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Adresse de connecteur détournée par la requête (SSRF, T) | L'adresse vient du catalogue ; seul un GUID de tenant s'y insère ; puis contrôles habituels (HTTPS, adresse publique) | F | `mcp.test.ts` (« Catalogue »), `catalog.test.ts` |
| Enregistrement OAuth dynamique abusé (S, E) | Client public PKCE, une seule adresse de retour (la nôtre), point d'enregistrement vérifié (HTTPS, public), réponse validée | F | `oauth.test.ts` (« enregistrement dynamique ») |
| Connecteur ajouté qui agit sans contrôle (E) | En attente jusqu'à l'examen outil par outil (lecture / écriture décidée par l'administrateur), écritures validées par l'utilisateur | F | tests MCP existants |
| Zip bomb (D) | Décompression en flux, plafonds sur les octets réellement produits, 100 entrées | F | `archive.test.ts` (12 Mo de zéros en < 100 Ko refusés) |
| Chemins piégés dans l'archive (T) | Rien n'est écrit sur disque ; chemins nettoyés (`..`, caractères de contrôle) | F | idem |
| Compétence importée piégée (T) | Mêmes contrôles qu'une compétence saisie ; scripts Python gardés (exécutés seulement dans le bac à sable, voir 3.4 nonies), autres langages mis de côté | M (détecteur heuristique) | `runs.routes.test.ts` (« import zip ») |
| Fuite des données d'un connecteur par un contenu qu'il renvoie (I) — *revue adversariale du 25 octobre* | Un résultat MCP est non fiable ET privé : à lui seul, il expose la réponse. Retour libre vers le même connecteur (la donnée ne change pas de mains) ; vers le web ou un autre connecteur, accord de l'utilisateur avec ce qui sort. Avant : un ticket Jira piégé pouvait faire ouvrir `evil.example/?d=…` sans accord | F | `exposure.test.ts` (« ticket Jira piégé »), cas d'évaluation `securite-connecteur-exfiltration` (3/3 sur gemini-3.5-flash-lite) |
| Outil d'écriture annoncé en lecture par l'éditeur (E) — *revue adversariale du 25 octobre* | `readOnlyHint` n'est qu'une déclaration : un outil au nom de modification (create, delete, send…) n'est jamais pris pour une lecture, il est signalé ; la liste de ce qui sera approuvé reste visible dans les modes prédéfinis | M (heuristique sur le nom ; l'administrateur reste juge) | `connectors.spec.ts` (outil `delete_page` piégé) |

### 3.4 undecies API publique (/v1) et clés d'API (27 octobre)

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Clé volée en base (I) | Seule l'empreinte SHA-256 est gardée (≈ 300 bits d'aléa : pas de recherche exhaustive) ; préfixe affiché, jamais la clé ; jamais dans l'audit | F | `apikeys.integration.test.ts`, test « un administrateur crée une clé » |
| Clé fuitée chez l'intégrateur (S, E) | Agents listés seulement, 365 jours au plus, révocation immédiate, 60 appels/min par clé, quotas de l'organisation, audit de chaque appel (`api.request`) et de chaque échec (`api.auth_failed`, préfixe seulement) | M : valable jusqu'à sa révocation | tests « refus » |
| Clé qui survit à son créateur (E) | Valide seulement si son créateur est TOUJOURS administrateur (vérifié à chaque appel, en base) | F | tests « créateur rétrogradé » (route et Postgres) |
| Membre qui fabrique une clé (E) | Création réservée aux administrateurs (politique d'insertion, en son propre nom) ; index de recherche sans aucun droit pour l'application, lu par une seule fonction `SECURITY DEFINER` | F | `apikeys.integration.test.ts` |
| Clé utilisée sur l'interface, ou session sur l'API (E) | Routes `/v1` : clé seulement ; interface : session seulement | F | test « clé sur une route de l'interface » |
| Application qui valide une écriture à la place d'un humain (E) | Aucune validation par l'API : réponse 202 « needs_approval », une personne décide dans Snowfall | F | test « écriture demandée par l'agent » |
| Contournement des contrôles du chat (T) | Le message passe par la MÊME route que l'interface (quotas, routage, règle de deux, données sensibles, audit) | F | tests de l'API (réponse identique) |
| Conversation d'un autre agent lue par une clé (I) | Lecture et suite seulement pour une conversation avec un agent permis à la clé | F | test « conversation d'un autre agent : introuvable » |

### 3.5 Artifacts

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Script du modèle exécuté dans l'application (E, I) | iframe sandbox sans same-origin, CSP propre, scripts seulement sur clic, panneau recréé à chaque ouverture | F | tests d'écran, essais navigateur |
| Message forgé par le cadre (T) | Seuls les messages du cadre affiché sont acceptés ; SVG renvoyé seulement téléchargé | F | revue, `ArtifactPanel.tsx` |

### 3.6 Fournisseurs d'IA et traces

| Menace | Mesures | Résiduel | Preuve |
|---|---|---|---|
| Conservation ou réutilisation par le fournisseur (I) | Liste blanche par organisation, contenus minimisés, local pour le confidentiel | **M** : contrats (DPA) à signer | AIPD |
| Copie des données dans les traces (I) | Langfuse interne, masquage, rien pour le confidentiel, 30 jours | F | `tracing.test.ts` |

## 4. Risques résiduels prioritaires

1. **Injection de prompt, détection limitée** (M) : l'exfiltration est couverte par la règle de deux, le marquage des contenus externes et la politique des liens ; la détection heuristique n'attrape que les injections recopiées. Reste : un document interne piégé peut orienter le premier appel sortant. Classifieur local mesuré (Laya) : 11/12 attaques, mais 6/12 faux positifs sur v2 — non déployé.
2. **Contrats des fournisseurs d'IA** (M) : DPA, localisation, non-conservation.
3. **Connecteurs en jeton partagé** (M) : préférer le mode OAuth (compte de chacun) pour les outils qui écrivent ; les connecteurs OpenAPI n'ont pas encore ce mode.
4. **gVisor non vérifié sur l'hôte de production** : à faire avant d'ouvrir l'interpréteur.
5. **Pas de test d'intrusion externe** : dossier de cadrage prêt (`PENTEST_SCOPE.md`).
6. **Compétences venues d'ailleurs** (M) : une compétence est une consigne, par nature ; ses textes comptent comme données internes (règle de deux), pas comme contenu non fiable. Une compétence téléchargée sur internet puis importée garde donc la confiance d'un document de l'organisation : à relire avant de la confier à un agent.
