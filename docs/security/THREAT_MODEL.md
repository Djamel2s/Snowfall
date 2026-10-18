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
| Escalade par délégation (E) | Spécialiste en lecture seule (sa base), profondeur 1, budget court | F | `runs.routes.test.ts` (sous-agents) |
| Fuite du confidentiel par un spécialiste (I) | Refus si contexte ou base confidentiels et modèle externe, audité | F | test « base confidentielle » |
| Fichier audio ou image piégé (T) | Signature vérifiée, taille bornée, antivirus pour les images, rien d'exécuté | F | `audio.test.ts`, `image-tool.test.ts` |
| Écoute par un artifact (I) | Micro autorisé pour l'application seule, bloqué dans les artifacts | F | en-têtes nginx |

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

1. **Injection de prompt, détection limitée** (M) : l'exfiltration est couverte par la règle de deux, le marquage des contenus externes et la politique des liens ; la détection heuristique n'attrape que les injections recopiées. Reste : un document interne piégé peut orienter le premier appel sortant. Piste : classifieur local facultatif.
2. **Contrats des fournisseurs d'IA** (M) : DPA, localisation, non-conservation.
3. **Connecteurs en jeton partagé** (M) : préférer le mode OAuth (compte de chacun) pour les outils qui écrivent ; les connecteurs OpenAPI n'ont pas encore ce mode.
4. **gVisor non vérifié sur l'hôte de production** : à faire avant d'ouvrir l'interpréteur.
5. **Pas de test d'intrusion externe** : dossier de cadrage prêt (`PENTEST_SCOPE.md`).
