# État des lieux — 17 octobre 2026

> Pause volontaire après les phases 1 et 2 du cadrage
> ([CADRAGE_HARNESS.md](CADRAGE_HARNESS.md)) : ce qui est fait, les écarts avec
> ce qu'on avait décidé, ce qui manque, et le plan révisé.

## 1. En bref

- **Le socle de sécurité est solide** (authentification BFF, RLS, chiffrement par
  organisation, audit, proxy de sortie, CSP stricte), mais **la preuve n'a pas
  suivi** : la base de sécurité s'arrête au 14 octobre, et tout ce qui a été ajouté
  depuis (outils, bac à sable, MCP, traces, web, artifacts) n'y est pas décrit.
- **Le moteur d'agent est au niveau de l'état de l'art** (outils, validation
  humaine, exécution durable, cache, compaction, traces, évaluations).
- **Le confort de LibreChat manque presque entièrement** : branches, partage,
  export, prompts, presets, mémoire, retour 👍👎…
- **L'interface a dérivé** : les réglages sont devenus un fourre-tout, et une
  fonction peut exister sans qu'on sache où la trouver (MCP).
- **On a avancé plus vite qu'on n'a vérifié** : deux relectures ont trouvé une
  vingtaine de défauts réels dans le code des deux derniers jours.

**Recommandation : un sprint de consolidation avant toute nouvelle fonction**,
puis le confort LibreChat, dans l'ordre de la section 8.

## 2. Ce qui est solide

| Domaine | Acquis |
|---|---|
| Identité et sessions | Keycloak OIDC (PKCE, PAR), TOTP obligatoire, BFF sans jeton dans le navigateur, déconnexion par le fournisseur d'identité, SSO par organisation |
| Isolation | RLS `FORCE` sur toutes les tables, rôles à moindre privilège, contexte de tenant par transaction |
| Données | Chiffrement AES-256-GCM par organisation (KMS Vault/OpenBao), rotation des clés, contraintes qui refusent le clair |
| Audit et supervision | Journal append-only, SIEM, Prometheus/Loki/Grafana, alertes de sécurité |
| Exploitation | Sauvegardes chiffrées avec test de restauration mensuel, runbook |
| Entrées | Antivirus fail-closed, extraction isolée, anti-SSRF, proxy de sortie à liste de domaines |
| Agents | Outils avec autorisations à 3 niveaux, validation humaine des écritures, exécution durable chiffrée, bases confidentielles jamais envoyées à l'extérieur |
| Outils | Recherche web (SearXNG), artifacts isolés, interpréteur de code attaqué puis durci, MCP (serveurs approuvés, empreintes) |
| Qualité IA | Évaluation RAG en CI, banc d'évaluation des agents, traces Langfuse internes |

## 3. Écarts avec les décisions du cadrage

| Décidé le 16/10 | Réalité | Action |
|---|---|---|
| Interpréteur : **micro-VM éphémère** | Conteneur durci ; gVisor **optionnel**, `runc` par défaut | Exiger gVisor en production (le bac à sable refuse de démarrer sans) ou passer à Firecracker ; documenter le choix |
| MCP : **jetons OAuth par utilisateur** dans le KMS | Un jeton statique par serveur, pour toute l'organisation | Soit OAuth par utilisateur (actions faites au nom de chacun), soit acter la limite |
| Quotas couvrant **le coût des outils** | Seuls les jetons des modèles sont comptés | Compter exécutions de code, recherches et appels MCP |
| Limites par exécution : étapes, **jetons, durée, coût** | Étapes seulement | Plafond de jetons et de durée par réponse |
| Observabilité : **retour 👍👎 et évaluations en ligne** | Ni l'un ni l'autre | Retour utilisateur relié aux traces ; échantillon évalué automatiquement |
| Livrable phase 2 : **tests d'injection passés** | 3 cas d'injection dans le banc ; aucune détection | Jeu d'attaques plus large et couche de détection |
| Sorties structurées (JSON validé) | Non fait | Utile pour MCP et futures actions OpenAPI |
| Artifacts : HTML, **React**, Mermaid, SVG, documents | HTML, SVG, Mermaid | React (isolé) à évaluer |

## 4. Sécurité : niveau réel

**Forces.** Les contrôles d'infrastructure et de données sont du niveau attendu
pour une certification. Chaque outil d'agent a été pensé contre l'injection de
prompt (contenu balisé, aucun outil sensible déclenché par un résultat, validation
humaine, anti-exfiltration des adresses).

**Faiblesses à traiter avant de se dire « au top » :**

1. **Documentation de preuve en retard.** `SECURITY_BASELINE.md` §11 et §12 ne
   couvrent rien depuis le 14/10. Un auditeur juge sur pièces : un contrôle non
   décrit n'existe pas.
2. **Pas d'analyse de risques formelle** : ni modèle de menaces par outil, ni AIPD
   (analyse d'impact RGPD), ni registre des traitements IA. Le cadrage contient
   les risques, mais pas sous une forme auditable.
3. **Injection de prompt : défense en profondeur incomplète.** Rien ne détecte un
   contenu piégé. On compte sur le balisage et sur la sagesse du modèle.
4. **Vérification trop tardive.** Les relectures adverses ont trouvé des trous
   réels (balise reconstituée dans 7 blocs de données, approbation MCP
   contournable, mode « Exécuter » hérité…). Ils sont corrigés, mais ils ont été
   trouvés *après*.
5. **Chaîne de livraison incomplète.** La CI construit et scanne les images API
   et web, **pas celle du bac à sable** (Python et ses dépendances). Aucun test de
   bout en bout dans un navigateur.
6. **Aucun test d'intrusion externe** à ce jour.

## 5. Parité LibreChat

| Fonction | État | Priorité |
|---|---|---|
| Multi-fournisseurs, choix du modèle, agents, base de connaissances, pièces jointes | ✅ | — |
| Modifier, régénérer, arrêter, rechercher, projets | ✅ | — |
| Recherche web, interpréteur de code, artifacts, MCP | ✅ (MCP non essayé en vrai) | — |
| Reprise d'une réponse après déconnexion, raisonnement visible | ✅ | — |
| **Branches de conversation** (modifier crée une branche au lieu d'écraser) | ✅ | — |
| **Partage** interne en lecture | ✅ | — |
| **Retour 👍👎** sur les réponses | ✅ (+ taux par agent) | — |
| **Export / import** (Markdown, JSON ; import ChatGPT/LibreChat) | ✅ (pas d'export PDF) | — |
| **Bibliothèque de prompts** et commandes « / » | ✅ | — |
| **Presets** et **paramètres du modèle** (température, longueur, effort) | ✅ (réglages par agent : créativité, longueur) | — |
| **Mémoire** (désactivée par défaut, visible, effaçable) | ✅ | — |
| **Conversation temporaire** | ✅ | — |
| **OCR** (PDF scannés, images) | ✅ (local, profil « ocr ») | — |
| **Catalogue d'agents** (duplication, droits fins) | ✅ (droits fins : plus tard) | — |
| Favoris et étiquettes, archivage | ❌ | P3 |
| Comparaison de modèles, images, voix, actions OpenAPI, API d'agents | ❌ | P3 |
| Sous-agents / chaînes d'agents | ❌ | P3 |

## 6. Expérience utilisateur

### Les réglages sont devenus un fourre-tout

Aujourd'hui, un seul panneau qui défile empile **10 sections** : profil,
préférences, consommation, fournisseurs, quotas, connaissances, outils, membres
et invitations, SSO, serveurs MCP. Il mélange ce qui me concerne (ma langue) et
ce qui concerne l'organisation (les quotas de tous). Chaque nouvelle fonction y
ajoute une carte.

**Proposition**, toujours dans la barre latérale et sans fenêtre modale :

```
Réglages
 ├─ Mon compte            profil · préférences · ma consommation
 └─ Organisation          (administrateurs seulement)
     ├─ Modèles et quotas      fournisseurs autorisés · plafonds
     ├─ Connaissances          embeddings · import de liens
     ├─ Outils et intégrations outils activés · serveurs MCP · état des services
     ├─ Membres et accès       membres · invitations · SSO
     └─ Sécurité               (plus tard : journal d'audit, rétention, export RGPD)
```

Règle pour la suite : **une fonction n'ajoute pas une carte**, elle s'insère dans
une rubrique existante, ou en crée une si elle le justifie.

### Une fonction peut exister sans qu'on la voie

Un outil passe par **4 niveaux** pour devenir utilisable :
1. installé sur la plateforme (variable d'environnement, service) ;
2. activé par l'organisation ;
3. choisi par l'agent ;
4. validé à chaque écriture.

Les niveaux sont justes (sécurité), mais **invisibles** : un outil non installé
est simplement caché, d'où « je ne vois pas MCP ». **Proposition :** dans « Outils
et intégrations », afficher chaque outil avec son état (*non installé sur la
plateforme*, *désactivé*, *activé*) au lieu de le masquer.

### Autres frictions relevées

- Écrans livrés **sans vérification dans le navigateur** : carte d'artifact,
  téléchargement, écran MCP.
- Logo et alignements corrigés en plusieurs allers-retours : il faut une
  vérification visuelle (bureau et mobile) avant chaque livraison d'écran.

## 7. Qualité du code et méthode

| Constat | Risque | Action |
|---|---|---|
| `App.tsx` : 1 438 lignes, 22 états | Chaque ajout casse autre chose | Découper en hooks (conversations, exécution en cours, artifacts, fichiers) |
| Tests web : 28 tests unitaires, aucun test d'écran | Régressions d'interface invisibles | Tests de bout en bout (Playwright) sur 5 parcours clés |
| CI sans le bac à sable | Vulnérabilité Python non vue | Build + Trivy + vérification des empreintes `pip` |
| Trous trouvés après coup | Dette de sécurité | **Définition de « terminé »** ci-dessous |

**Définition de « terminé »** (pour chaque fonction, à partir de maintenant) :
1. tests automatisés, y compris des chemins d'échec et d'attaque ;
2. relecture adverse, avec contre-vérification des points soulevés ;
3. écran vérifié dans le navigateur, sur bureau et sur mobile ;
4. `SECURITY_BASELINE.md` mis à jour (contrôle et limites) ;
5. évaluation des agents relancée si le prompt ou les outils changent ;
6. fiche de cours.

## 8. Plan révisé

### Sprint 0 — Consolidation : fait le 17 octobre

| # | Tâche | Résultat |
|---|---|---|
| 1 | Réglages réorganisés | « Mon compte » / « Organisation » en 4 rubriques ; outils non installés visibles et grisés avec la raison ; vérifié sur bureau et mobile |
| 2 | `SECURITY_BASELINE.md` | Contrôles de la plateforme d'agents ajoutés (§11), limites connues mises à jour (§12) |
| 3 | Analyse de risques | [THREAT_MODEL.md](../security/THREAT_MODEL.md) et trame d'[AIPD](../security/AIPD.md) |
| 4 | Bac à sable | gVisor exigé en production (refus de démarrer sans) ; batterie de 15 attaques versionnée et lancée en CI ; image scannée par Trivy |
| 5 | Quotas et plafonds | Plafonds mensuels d'appels d'outils (code, web, MCP) ; budget de tokens et durée maximale par réponse |
| 6 | Interface | Premiers hooks extraits de `App.tsx` ; 12 tests d'écran (Playwright) en CI, qui ont trouvé deux vrais défauts : saisie impossible sur l'écran d'accueil, réponse affichée deux fois un instant |

Fait le 18 octobre : la réponse en cours (flux, étapes, réflexion, pause sur
validation, reprise, arrêt, reconnexion) vit dans `hooks/useRun.ts` ; `App.tsx`
passe de 1 572 à 1 389 lignes. Ces parcours n'avaient aucun test d'écran : trois
ont été ajoutés avant de valider le déplacement (`e2e/approval.spec.ts`).

Reste du sprint 0 : vérifier gVisor sur l'hôte de production. `App.tsx` reste
gros : les conversations (chargement, création, liste) sont le prochain bloc à
sortir, quand une fonction y touchera.

### Plan initial du sprint 0 (pour mémoire)

| # | Tâche | Pourquoi |
|---|---|---|
| 1 | Réorganiser les réglages (section 6) et afficher l'état des outils | Ton retour : le fourre-tout |
| 2 | Mettre à jour `SECURITY_BASELINE.md` (contrôles des phases 1 et 2, limites) | Preuve pour la certification |
| 3 | Modèle de menaces par outil et trame d'AIPD | Analyse de risques auditable |
| 4 | gVisor exigé en production pour le bac à sable ; bac à sable dans la CI | Écart avec la décision n° 2 |
| 5 | Quotas sur les outils, plafonds de jetons et de durée par réponse | Écarts du cadrage |
| 6 | Découper `App.tsx` ; premiers tests Playwright | Stabilité de l'interface |

### Phase 3 — Confort LibreChat

Fait le 17 octobre :
- **Catalogue d'agents** : cartes (avatar, nom, modèle, outils), recherche,
  filtre « les miens », duplication (la base de connaissances n'est pas copiée).
- **Branches de conversation** : modifier ou régénérer crée une version ;
  ‹ 1/2 › pour passer de l'une à l'autre.
- **Retour 👍👎** sur les réponses : commentaire facultatif (chiffré) après 👎 ;
  la note seule rejoint la trace de la réponse dans Langfuse.
- Corrigé au passage, trouvé par les tests d'écran : sur mobile, choisir une
  section dans la barre latérale refermait le tiroir.

Puis, le même jour, le reste de la phase 3 :
- **Partage interne** : lien en lecture seule (1, 7 ou 30 jours) vers un instantané
  de la branche affichée, réservé à l'organisation, révocable ; refusé pour une
  base confidentielle ou une conversation temporaire.
- **Export / import** : Markdown ou JSON d'une conversation ; export de toutes mes
  données (RGPD) ; import ChatGPT, LibreChat, Snowfall.
- **Réglages des réponses** par agent : créativité et longueur, bornées côté serveur.
- **Bibliothèque de prompts** (barre latérale) : privés ou partagés, variables
  `{{…}}`, « / » dans la saisie.
- **Conversation temporaire** (sablier en haut) : hors historique et recherche,
  rien dans les traces, effacée sous 24 h.
- **Mémoire** (Mon compte) : désactivée par défaut ; « retiens que… » avec
  validation ; visible, effaçable ; jamais en temporaire ni en confidentiel.
- **OCR local** (profil « ocr ») : PDF numérisés et images lus dans un conteneur
  sans réseau.
- **Taux de 👍 par agent** sur les cartes du catalogue, à partir de 5 personnes.

Reste de la parité (P3) : favoris et étiquettes, archivage, export PDF, presets
de conversation hors agents, droits fins sur les agents.

### Phase 4 — Sécurité avancée et ouverture

Fait le 18 octobre, première étape (détection des injections) :
- **Banc enrichi** : 13 cas d'injection (pièces jointes, mémoire, web, fausses
  balises, faux accord, exfiltration par image ou par requête, langue étrangère)
  et un cas témoin. Il a trouvé une vraie faille : un souvenir piégé était suivi
  3 fois sur 3 (lien d'hameçonnage, puis demande de mot de passe). Corrigé : la
  mémoire refuse liens, adresses, secrets et consignes, avant même la validation.
- **Détection heuristique** : avertissement de la plateforme devant un contenu
  suspect, audit sans contenu, alerte sur la carte de validation qui suit.
- **Mesure honnête** : 100 % sur ce qui a servi à régler, **0/12** sur un jeu
  tenu à l'écart d'attaques reformulées. L'heuristique ne protège pas d'un
  attaquant qui s'adapte ; les contrôles structurels restent la défense.
- Banc complet après coup : 50/50 (aucune régression).
- **Règle de deux** (choisie plutôt qu'un classifieur) : dès qu'une réponse a lu
  un contenu externe ET des données internes, tout appel sortant (recherche web,
  page, MCP) demande l'accord, avec ce qui sortirait. Fondée sur la provenance :
  une injection reformulée ne la contourne pas. Aucune validation de plus sur les
  50 essais du banc ; un modèle qui obéit au piège est arrêté avant la fuite.

Puis le reste de la phase 4 :
- **Marquage des contenus externes** (spotlighting) : pages web et résultats
  d'outils tiers marqués « ˆ » ; contrôle ajouté à tout le banc (le marqueur ne
  doit jamais apparaître dans une réponse).
- **Liens des réponses** : cliquables seulement vers un domaine déjà apparu dans
  la conversation ; sinon affichés avec leur domaine, ouverts au second clic.
- **OAuth MCP par utilisateur** : chacun se connecte avec son compte (PKCE,
  découverte, indicateur de ressource) ; carte « Connexions » dans Mon compte.
  Test réel en navigateur : un double envoi du code (mode strict de React) aurait
  fait échouer la connexion, corrigé.
- **Connecteurs OpenAPI** : une API décrite par sa spécification devient un
  connecteur, avec toute la chaîne MCP (examen, empreintes, validation, règle de deux).
- **Sous-agents** : un agent consulte jusqu'à 5 spécialistes, en lecture seule
  de leur base, profondeur 1, jamais de confidentiel vers un modèle externe.
- **Voix locale** (dictée, lecture) et **images locales** (`generate_image`) :
  branchées et testées ; services à déployer (images à figer par empreinte).
- **Test d'intrusion** : dossier de cadrage prêt pour un prestataire externe.

## 9. Décisions à prendre

1. **Sprint 0 d'abord ?** Il retarde les fonctions LibreChat d'environ une à deux
   semaines.
2. **Bac à sable** : gVisor obligatoire (simple, déjà prévu) ou Firecracker
   (micro-VM, plus isolé, plus lourd) ?
3. **MCP** : OAuth par utilisateur maintenant, ou jeton par serveur pour l'instant
   (limite documentée) ?
4. **Ordre de la phase 3** : celui proposé, ou une fonction te manque plus que
   les autres ?
