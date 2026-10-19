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
