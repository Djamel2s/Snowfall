# Snowfall — Runbook d'exploitation

Procédures pour les opérateurs de la plateforme. Toutes les commandes se lancent
depuis la racine du dépôt, avec le fichier `.env` (développement) ou les secrets
injectés par le gestionnaire (production).

## 1. Mise à jour d'une installation existante

```bash
npm run db:migrate        # nouvelles tables, fonctions, droits du rôle applicatif (dont tool_usage, mcp_servers…)
npm run keycloak:sync     # réglages du realm déjà importé (SMTP, organisations,
                          # déconnexion back-channel, scope "organization")
```

Keycloak n'applique `infra/keycloak/realm/snowfall-realm.json` qu'à la création du
realm : sans `keycloak:sync`, une installation existante garde ses anciens réglages.

L'API refuse de démarrer si une migration manque (message explicite).

## 2. KMS (OpenBao / HashiCorp Vault Transit, authentification AppRole)

**OpenBao interne** (profil `kms` de `compose.prod.yaml`) :

1. Certificat TLS dans `infra/tls/openbao/` (`server.crt`, `server.key`, `ca.crt`).
2. `docker compose -f compose.yaml -f compose.prod.yaml --profile kms up -d openbao`
3. `bao operator init -key-shares=5 -key-threshold=3` (dans le conteneur) :
   répartir les 5 clés de descellement entre personnes différentes, mettre le
   jeton racine au coffre. Desceller avec 3 clés (`bao operator unseal`) après
   chaque redémarrage.
4. `BAO_TOKEN=<jeton racine> sh /openbao/bootstrap/bootstrap.sh` : Transit, clé
   `snowfall` dérivée et non exportable, politique minimale `snowfall-api`
   (chiffrer, déchiffrer, rechiffrer — rien d'autre), rôle AppRole aux jetons
   d'1 h (24 h max), utilisables depuis le seul réseau interne. Puis révoquer
   le jeton racine (`bao token revoke`).
5. Copier `role_id` dans `VAULT_ROLE_ID` et `secret_id` dans
   `infra/secrets/vault_secret_id` (secret Docker), puis effacer
   `/openbao/approle`.

**Vault externe** : mêmes commandes (`vault` au lieu de `bao`, audit à activer
par `vault audit enable`), `VAULT_ADDR` vers le cluster, son nom dans
`infra/egress/allowed-domains.txt`, son AC dans `infra/tls/ca.crt`.

**Rotation du secret_id** (tous les 30 jours au plus) :
`bao write -f -field=secret_id auth/approle/role/snowfall-api/secret-id >
infra/secrets/vault_secret_id`, puis redémarrer l'API ; révoquer l'ancien
(`auth/approle/role/snowfall-api/secret-id-accessor/destroy`). En production,
un jeton statique (`VAULT_AUTH=token`) est refusé au démarrage.

**Basculer une installation existante** (aucune interruption) : `KMS_PROVIDER=vault`
et l'AppRole, redémarrer (les clés enveloppées localement restent lisibles),
puis `npm run keys:rotate -- --kek`. Conserver `SNOWFALL_MASTER_KEY`.

## 3. Rotation des clés

| Besoin | Commande |
|---|---|
| Rotation de la KEK (planifiée, annuelle) | `vault write -f transit/keys/snowfall/rotate` puis `npm run keys:rotate -- --kek` |
| Nouvelle clé de données pour toutes les organisations | `npm run keys:rotate -- --dek` |
| Compromission supposée d'une organisation | `npm run keys:rotate -- --dek --org <uuid> --reencrypt`, puis `npm run keys:rotate -- --verify --org <uuid>` (doit afficher 0) avant de retirer l'ancienne version |
| Preuve pour un audit | `npm run keys:rotate -- --verify` : valeurs restantes sur une ancienne version, table par table (code de sortie 2 s'il en reste) |

Chaque valeur chiffrée porte la version de sa clé : les données anciennes restent
lisibles après une rotation ; `--reencrypt` les rechiffre avec la nouvelle version.

## 4. SSO par organisation (Entra ID, Google Workspace)

1. Keycloak (console d'administration du realm `snowfall`) :
   *Organizations* → créer l'organisation (alias, ex. `acme`) et son domaine
   e-mail vérifié ; *Identity providers* → ajouter le fournisseur OpenID Connect
   d'Entra ID ou de Google Workspace, l'associer à l'organisation, cocher
   « Redirect when e-mail domain matches » et « Trust email » si le fournisseur
   garantit l'e-mail.
2. `.env` : `OIDC_EXTRA_SCOPES=organization`, puis redémarrer l'API.
3. Snowfall : Paramètres → SSO de l'organisation (owner) → alias `acme` et rôle par
   défaut (membre ou lecteur).

À la première connexion, un compte de l'organisation Keycloak est rattaché
automatiquement, avec un e-mail vérifié. Aucun autre compte n'est créé.

## 5. E-mails

Développement : Mailpit (`docker compose up -d mailpit`), interface
http://localhost:8025. Production : `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
`SMTP_PASSWORD`, `SMTP_FROM` (STARTTLS ou TLS), puis `npm run keycloak:sync`.

## 6. Journal d'audit

- **Collecte** : une ligne JSON `{"audit": {...}}` par événement sur la sortie de
  l'API (Vector, Fluent Bit, Promtail…), et/ou envoi direct
  (`SIEM_WEBHOOK_URL`, `SIEM_FORMAT=json|splunk-hec`).
- **Conservation** : `AUDIT_RETENTION_DAYS` (365 par défaut, 90 minimum).
- **Purge mensuelle** (compte de migration) :

  ```bash
  npm run audit:purge -- --archive audit-$(date +%Y-%m).jsonl
  ```

  Chiffrer l'archive (`age`) et la déposer sur un stockage WORM. `--dry-run`
  affiche ce qui serait purgé.

## 7. En-têtes de sécurité et CSP

Servis par nginx (`infra/nginx/security-headers.conf`). Les violations CSP sont
journalisées (`security.csp_violation`). Avant d'ajouter une ressource externe ou
du code en ligne, adapter la politique plutôt que l'affaiblir globalement.

## 8. Déconnexion back-channel

Keycloak appelle `POST /auth/backchannel-logout` de l'API (réseau interne en
production : `http://api:3001`, en développement `host.docker.internal:3001`).
Une session fermée côté Keycloak (administrateur, désactivation du compte,
déconnexion ailleurs) ferme immédiatement la session Snowfall correspondante.

## 9. Bases de connaissances

- **Migrations** : `npm run db:migrate` (tables `knowledge_*`, triggers, file
  d'imports). Le démarrage refuse une base non migrée.
- **Embeddings** : par défaut aucun (recherche par mots-clés, rien ne sort).
  Un admin choisit le fournisseur dans *Réglages → Bases de connaissances*,
  parmi ceux configurés (`*_API_KEY`) et autorisés. Pour des embeddings
  locaux : `LOCAL_LLM_BASE_URL` + `LOCAL_EMBEDDING_MODEL` (ex. `bge-m3` avec
  Ollama : `ollama pull bge-m3`).
- **Changement de modèle d'embeddings** : les sources existantes restent
  trouvables par mots-clés ; « Réindexer » une source recalcule ses vecteurs.
- **Bases confidentielles** : exigent un modèle local pour répondre (et pour
  les embeddings) ; un refus est tracé `knowledge.confidential_denied`.
- **Liens** : en production, faire sortir l'API par un proxy filtrant, ou
  couper l'import avec `KNOWLEDGE_LINKS=off`. Les refus SSRF sont tracés
  `knowledge.link_denied`.
- **Reprise** : un import interrompu (redémarrage) reprend automatiquement au
  démarrage suivant.
- **Qualité de la recherche** : `npm test` exécute le jeu d'évaluation
  (`retrieval.eval.test.ts`) et échoue si le rappel baisse. Pour un
  reclassement, servir par exemple `BAAI/bge-reranker-v2-m3` avec vLLM
  (`vllm serve BAAI/bge-reranker-v2-m3 --task score`) ou Text Embeddings
  Inference, puis renseigner `RERANK_BASE_URL` (et `RERANK_API=tei` pour TEI).

## 10. Antivirus (ClamAV)

- **Production** : service `clamav` de `compose.prod.yaml`, toujours actif. Le
  premier démarrage télécharge les signatures (quelques minutes) ; l'API attend
  qu'il soit sain. Si ClamAV tombe, les dépôts de fichiers sont refusés (503) :
  c'est voulu.
- **Développement** : `docker compose --profile antivirus up -d clamav`, puis
  `ANTIVIRUS=clamav` et `CLAMAV_HOST=localhost` dans `.env`.
- **Test** : déposer le fichier de test EICAR (texte standard, inoffensif) ; le
  refus apparaît dans l'audit sous `security.malware_detected`.
- **Mémoire** : ClamAV utilise ~1,5 Go avec les signatures (limite 3 Go).

## 11. Proxy de sortie (Squid)

- Seule sortie Internet de l'API et de ClamAV (réseau `backend` interne).
- **Domaines autorisés** : `infra/egress/allowed-domains.txt` (ajouter le nom
  public de Keycloak de `OIDC_ISSUER`, le SIEM et Vault s'ils sont externes) ;
  sites pour l'import de liens : `infra/egress/knowledge-domains.txt`, ou tout
  le web public en décommentant `http_access allow backend` dans `squid.conf`.
  Les destinations internes restent refusées dans tous les cas.
- Appliquer une modification : `docker compose -f compose.yaml -f compose.prod.yaml restart egress`.
- **Diagnostic** : `docker compose logs egress` (une ligne par connexion,
  `TCP_DENIED/403` pour un refus).

## 12. Supervision (Prometheus, Alertmanager, Loki, Grafana)

- **Accès** : Grafana écoute sur `127.0.0.1:3000` du serveur (tunnel SSH :
  `ssh -L 3000:127.0.0.1:3000 serveur`). Tableau « Snowfall — exploitation et
  sécurité » : disponibilité, latences, consommation des modèles, menaces
  bloquées, refus de sécurité, journaux du proxy, des sauvegardes et du KMS.
- **Métriques de l'API** : port interne 9464, jeton `infra/secrets/metrics_token`
  (même valeur que `METRICS_TOKEN`). Aucune donnée d'utilisateur ni de contenu.
- **Journaux** : Alloy lit les fichiers de journaux de Docker (lecture seule,
  sans accès au socket) et les envoie à Loki (30 jours). Le journal d'audit de
  référence reste en base et dans le SIEM.
- **Alertes** : `infra/monitoring/prometheus/alerts.yml` (disponibilité,
  sécurité) et `infra/monitoring/loki/rules` (sauvegarde manquante ou échouée,
  sorties refusées, refus du KMS) → Alertmanager → e-mail (adapter
  `alertmanager.yml`, mot de passe SMTP dans `infra/secrets`).
- **SIEM** : l'audit applicatif part déjà vers `SIEM_WEBHOOK_URL` ; pour le
  proxy de sortie, ajouter dans `squid.conf` une ligne
  `access_log tcp://<siem>:514 snowfall` ; OpenBao journalise sur sa sortie
  standard (collectée par Alloy).
- **Base de supervision** : rôle `snowfall_monitor` (statistiques seules),
  créé par `npm run db:setup` si `MONITOR_DB_PASSWORD` est défini.

## 13. Sauvegardes et test de restauration

- **Clés** : deux paires age (`age-keygen`). La clé privée « hors site » va au
  coffre (jamais sur le serveur) ; la clé « de test » sert uniquement au test
  mensuel. Les deux clés publiques dans `infra/secrets/backup_recipients`, la
  clé de test dans `infra/secrets/backup_restore_identity`.
- **Rôle** : `snowfall_backup` (lecture seule, contourne la RLS pour un dump
  complet), créé par `npm run db:setup` avec `BACKUP_DB_PASSWORD`.
- **Planification** : service `backup`, chaque jour à `BACKUP_HOUR` UTC,
  rétention locale `BACKUP_KEEP_DAYS`. Copie hors site : `BACKUP_REMOTE`
  (rclone, ex. `s3:snowfall-backups`, configuration dans
  `infra/secrets/rclone.conf`) — utiliser un compartiment avec **verrouillage
  d'objet** (immuable : protège des rançongiciels) et autoriser son point
  d'accès dans le proxy de sortie.
- **Test mensuel** : `docker compose -f compose.yaml -f compose.prod.yaml run --rm backup-verify`
  → `restore_test_ok … duration_s=…` (à conserver comme preuve d'audit, avec la
  durée : temps de reprise mesuré). Vérifie empreintes, déchiffrement,
  restauration, nombre de lignes par table, migrations, chiffrement des messages.
- **Restauration réelle** : `infra/scripts/restore-db.sh` avec la clé hors site,
  puis `SNOWFALL_MASTER_KEY` et l'accès au KMS (sans eux, les données
  restaurées restent chiffrées).

## 14. IA locale (embeddings et reclassement)

- `docker compose -f compose.yaml -f compose.prod.yaml --profile local-ai up -d embeddings reranker`
  (premier démarrage : autoriser temporairement les domaines Hugging Face dans
  le proxy, puis `HF_HUB_OFFLINE=1`).
- API : `LOCAL_EMBEDDING_BASE_URL=http://embeddings/v1`,
  `LOCAL_EMBEDDING_MODEL=BAAI/bge-m3`, `RERANK_BASE_URL=http://reranker`,
  `RERANK_API=tei`. Puis, dans Snowfall : Réglages → Bases de connaissances →
  Embeddings « Local », et réindexer les sources existantes.
- **Résultats mesurés** (jeu fictif, 25 questions, CPU) : mots-clés R@3 0,84 ;
  hybride bge-m3 R@3 0,96 (97 ms/question) ; hybride + reclassement de 10
  passages R@1 = R@3 = 1,00 (2,3 s/question sur CPU partagé — prévoir un GPU,
  image `cuda-1.9.4`, ou `RERANK_CANDIDATES=5`). Mémoire : ~4,5 Go par modèle.
- **Mesurer sur vos documents** : `npm run knowledge:eval -- --docs <dossier>
  --questions <fichier.json> --embeddings http://<hôte>:<port>/v1 --rerank
  http://<hôte>:<port>` (questions : `[{"question": "...", "expected": "extrait
  attendu"}]`).

## 15. Agents : limites et quotas

- Par réponse : `AGENT_MAX_STEPS` (6), `AGENT_MAX_TOKENS` (400 000, toutes étapes :
  au-delà, plus d'outils), `AGENT_MAX_SECONDS` (600 s d'exécution active, pauses de
  validation exclues : au-delà, réponse arrêtée et partie écrite gardée).
- Par organisation et par mois : Réglages → Organisation → Modèles et quotas
  (tokens, et appels d'outils : code, web, MCP). Refus audités :
  `quota.denied`, `quota.tool_exceeded`, `agent.run_limit`.

## 16. Interpréteur de code (bac à sable, profil « code »)

1. Installer gVisor sur l'hôte (paquet `runsc`), puis `sudo runsc install` et
   redémarrer Docker. **gVisor est exigé** : sans lui, le bac à sable refuse de
   démarrer (`SANDBOX_REQUIRE_GVISOR=true`, valeur par défaut de production).
2. Vérifier sur l'hôte, avant d'ouvrir l'outil :
   `SANDBOX_RUNTIME=runsc scripts/sandbox-attack.sh` → doit afficher
   `Isolation : gvisor` et « tout est bloqué ».
3. `docker compose -f compose.yaml -f compose.prod.yaml --profile code up -d sandbox`
   puis, côté API : `SANDBOX_SOCKET=/run/sandbox/sandbox.sock`.
4. Activer « Interpréteur de code » dans Réglages → Organisation → Outils et intégrations.

## 17. Recherche web (profil « web-search »)

- `docker compose ... --profile web-search up -d searxng`, puis côté API
  `WEB_SEARCH_URL=http://searxng:8080`.
- Moteurs autorisés : `infra/egress/search-domains.txt` (SearXNG ne sort que vers eux).
- Activer « Recherche web » par organisation. Jamais proposée aux conversations
  avec une base confidentielle.

## 18. Serveurs MCP

- `MCP_ENABLED=true`. En production, l'API refuse de démarrer sans le proxy de
  sortie (`HTTPS_PROXY` et `NODE_USE_ENV_PROXY=1`).
- Ouvrir le domaine de chaque serveur dans `infra/egress/mcp-domains.txt`
  (second verrou, en plus de l'approbation par l'administrateur), puis
  redémarrer le proxy.
- Dans Snowfall : barre latérale › Connecteurs (l'outil « Connecteurs » doit être
  activé dans Réglages → Organisation → Outils et intégrations) : ajouter, choisir
  les outils (description et paramètres visibles en mode « Personnalisé »).
  Voir §31.
- Un outil modifié par le serveur est bloqué (`mcp.tool_changed`) jusqu'à une
  nouvelle approbation.

## 19. Traces des agents (Langfuse auto-hébergé)

- `docker compose -f compose.yaml -f compose.prod.yaml -f compose.observability.yaml up -d`
  (amorçage : `infra/langfuse/bootstrap.sh`).
- API : `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY_FILE`,
  `TRACE_CONTENT=masked` (ou `none`), `TRACE_RETENTION_DAYS=30`.
- Les traces plus anciennes sont supprimées par l'API (la rétention de Langfuse
  est réservée à son édition payante).

## 20. Évaluer les agents

- `npm run agent:eval -w @snowfall/api -- --model <fournisseur:modèle> --repeat 3 --out ref.json`
  pour une référence, puis `--baseline ref.json` après un changement de prompt,
  d'outil ou de modèle (code de sortie 1 en cas de régression). Coût : 2 à 4
  appels par cas.

## 21. OCR local (profil « ocr »)

- `docker compose -f compose.yaml -f compose.prod.yaml --profile ocr up -d ocr`,
  puis côté API `OCR_SOCKET=/run/ocr/ocr.sock` et redémarrage.
- Runtime gVisor par défaut (`OCR_RUNTIME=runsc`) ; sur un hôte sans gVisor :
  `OCR_RUNTIME=runc` (isolation moindre, à consigner).
- Vérifier : `docker run --rm --network none --read-only --tmpfs /work --tmpfs /tmp -v "$PWD/apps/ocr:/t:ro" snowfall-ocr python3 -I /t/ocr_test.py`
  (tous les contrôles « ok »).
- Sans OCR : les images sont refusées dans les bases (motif affiché), les PDF
  numérisés restent sans texte. Panne de l'OCR : source « Lecture du scan
  impossible », à relancer.
- Mise à jour de sécurité Debian : relever les versions figées dans
  `apps/ocr/Dockerfile` (Trivy les signale en CI).

## 22. Conversations temporaires et mémoire

- Purge : les conversations temporaires de plus de 24 h sont effacées par l'API
  (cycle de reprise des runs, toutes les 30 s ; audit `conversation.purge`).
  Rien à planifier ; vérifier l'absence d'arriéré :
  `SELECT count(*) FROM temporary_conversations WHERE expires_at < now() - interval '1 hour';`
  (rôle migrateur ; doit valoir 0).
- Mémoire : désactivée par défaut, activée par chaque utilisateur ; aucun
  administrateur ne peut la lire (RLS propriétaire). Effacement d'un compte :
  supprimée avec l'appartenance à l'organisation.

## 23. Mise à jour vers la phase 3

- `npm run db:migrate -w @snowfall/api` (applique aussi les droits du rôle
  applicatif) : nouvelles tables et fonctions (partages, prompts, conversations
  temporaires, mémoire, compteurs des agents) ; puis redémarrer l'API.

## 24. Injections de prompt

- Audit `agent.injection_suspected` : un contenu lu pendant une réponse (outil,
  passage, pièce jointe) contenait des consignes adressées à l'assistant. Détails :
  outil, signaux, score — jamais le contenu. Une hausse soudaine sur un même outil
  (ex. un serveur MCP, un domaine web) mérite une enquête.
- Mesurer le détecteur (gratuit, local) : `npx tsx scripts/injection-holdout.ts`
  dans `apps/api`. Ne jamais régler le détecteur sur le jeu « tenu à l'écart » :
  s'il sert à régler, en écrire un nouveau.
- Mesurer les agents : `npm run agent:eval -w @snowfall/api -- --model <p:modèle> --repeat 3 --only <cas securite-…>`.
- Règle de deux : une validation « Cette réponse a lu un contenu externe et des
  données internes » est normale ; elle protège contre l'exfiltration. Si les
  utilisateurs s'en plaignent sur un parcours précis, mesurer avec le banc avant
  d'assouplir quoi que ce soit (`agent/exposure.ts`).

## 25. Connecteurs : OAuth par utilisateur et API OpenAPI

- OAuth (MCP) : enregistrer chez le fournisseur un client avec l'adresse de
  retour `${APP_ORIGIN}/mcp/callback`, puis ajouter le serveur en mode « MCP ·
  compte de chacun » (identifiant client, secret facultatif). Le domaine du
  serveur MCP ET celui du serveur d'autorisation doivent être ouverts dans
  `infra/egress/mcp-domains.txt`. L'administrateur se connecte avec son compte
  pour lire et choisir les outils (le serveur est encore « à terminer »).
- Révoquer un utilisateur : sa connexion disparaît avec son départ ; il peut
  aussi se déconnecter depuis la fiche du connecteur.
- OpenAPI : Catalogue › « Connecteur personnalisé » › « API décrite par une
  spécification » : adresse de base, clé facultative, fichier JSON (OpenAPI 3).
  Domaine à ouvrir dans `mcp-domains.txt`.

## 26. Voix et images locales

- Voix (API audio compatible OpenAI, ex. Speaches) : `STT_URL`, `STT_MODEL`,
  `TTS_URL`, `TTS_MODEL`, `TTS_VOICE`. Images (API images compatible OpenAI) :
  `IMAGE_URL`, `IMAGE_MODEL`. Ajouter les noms internes à `NO_PROXY`.
- Avant de les ajouter à `compose.prod.yaml` : figer l'image par empreinte
  (publiée depuis plus de deux semaines), vérifier la licence du modèle choisi,
  réseau `backend` sans sortie, lecture seule, utilisateur non root, GPU réservé.
- Le micro n'est autorisé que pour l'application (`Permissions-Policy`), jamais
  dans les artifacts.

## 27. Routage des modèles (service de décision)

- Démarrer : `docker compose -f compose.yaml -f compose.prod.yaml --profile decision up -d decision`,
  puis côté API `DECISION_SOCKET=/run/decision/decision.sock` et redémarrer l'API.
  Sans service : le routage marche quand même, à l'heuristique seule.
- Activer : Paramètres › Organisation › Modèles et quotas › Routage automatique,
  choisir le modèle rapide et le puissant (fournisseurs autorisés seulement).
- Vérifier : les journaux de l'API montrent `model routed` avec `source: engine`
  (le service a répondu) ou `heuristic` (repli). Jamais le texte de la question.
- Changer de révision du modèle : nouvelle révision et empreintes dans le
  `Dockerfile` et `fetch_model.py`, puis la CI rejoue le jeu tenu à l'écart
  (`decision_test.py`) ; en dessous de 21/24, ne pas déployer. Changer la
  formulation de la question (`ROUTING_QUESTION`) oblige à remesurer le seuil.
- Atelier (Organisation › Modèles et quotas › Entraîner le décideur) : il faut au
  moins 5 exemples de chaque sorte en entraînement ET en test. « Revenir à la
  base » désactive la tête entraînée (les autres instances suivent sous 60 s).
  Une nouvelle révision du modèle Laya rend les têtes existantes inutilisables :
  le routage repasse à l'heuristique ; réentraîner.

## 31. Connecteurs et import de compétences

- Barre latérale › Connecteurs. Membres : les connecteurs prêts ; une fiche par
  connecteur avec « Se connecter à … » / « Déconnecter … ». Administrateurs :
  onglets « Ajoutés » et « Catalogue » ; la fiche montre les étapes (Ajouté →
  Connexion si OAuth → Outils → Prêt) et une seule action à la fois :
  - OAuth : « Ajouter et se connecter » enchaîne l'ajout et la connexion ; au
    retour, la fiche s'ouvre sur le choix des outils ;
  - choix des outils : « Lecture seule (recommandé) » (outils que l'éditeur
    annonce en lecture), « Lecture et écriture », ou « Personnalisé » (outil par
    outil, droit lecture/écriture, détail des paramètres). L'annonce « lecture »
    de l'éditeur est un conseil : vérifier en mode personnalisé en cas de doute ;
  - ensuite : « Modifier les outils », interrupteur « Activé pour
    l'organisation », « Supprimer » (deux clics).
- Puce « À terminer » : outils pas encore choisis ; « À connecter » : connexion
  OAuth manquante pour l'utilisateur courant.
- Avertissement « annoncé en lecture mais au nom de modification » : l'éditeur
  déclare l'outil en lecture alors que son nom dit le contraire. Il est laissé
  hors du mode « Lecture seule » ; ne l'approuver qu'en écriture, après lecture
  de sa description.
- Accord demandé sur un appel web après la lecture d'un connecteur : normal
  (règle de deux). Les données lues dans un connecteur peuvent y retourner
  librement ; vers l'extérieur, l'utilisateur voit ce qui sort et décide.
- « Le service ne répond pas » (`http_error`, `timeout`, `network`,
  `protocol_error`) : adresse fausse ou domaine absent de `mcp-domains.txt`.
- Ajout depuis le catalogue : si l'éditeur ne permet pas l'enregistrement
  automatique (`oauth_registration_required`), créer une application OAuth chez
  lui avec pour adresse de retour celle de Snowfall (`…/mcp/callback`), puis
  saisir son identifiant. Google Workspace : programme de préversion et
  application « AI-powered agent » dans Google Cloud. Microsoft 365 : identifiant
  du tenant Entra, Agent 365.
- Une adresse marquée « à vérifier » vient d'un annuaire : la lecture des outils
  confirme qu'elle répond avant toute activation.
- Compétences › Importer (.zip) : format Anthropic ; scripts Python gardés,
  autres langages (sh, js…) mis de côté.
- Dépendances : zod 4.6.6 et ip-address 10.7.4 appliqués ; fastify 5.12.6 et
  mermaid 12.2.0 (katex 0.18.10) appliqués le 27 octobre, versions désormais
  épinglées exactement. Reste (règle des 14 jours) : fast-uri 3.1.9 / 4.2.3 le
  2 novembre (vient de fastify : par `overrides`). Ne pas lancer
  `npm audit fix --force` (versions trop récentes, majeures possibles).
- Après une mise à jour de Mermaid : `artifact-csp.spec.ts` rend un diagramme
  sous la CSP de production du cadre (aucune violation, aucune requête).

## 32. API publique (/v1) et clés d'API

- Migrations `api_keys` et `api_keys_enforcement` : `npm run db:migrate` (droits
  réappliqués, dont `snowfall_api_key_lookup`), puis redémarrer l'API. Référence
  pour les intégrateurs : `docs/api/README.md`.
- Création : Paramètres › Organisation › Outils et intégrations › Clés d'API
  (administrateurs). La clé n'est montrée qu'une fois.
- Rotation : créer une nouvelle clé, la déployer chez l'intégrateur, puis
  révoquer l'ancienne.
- Clé fuitée : la révoquer (effet immédiat), puis relire l'audit `api.request`
  (`target_id` = identifiant de la clé) pour voir ce qui a été demandé.
- Surveillance : une rafale d'`api.auth_failed` signale un essai de clés ; le
  préfixe dans l'événement permet de reconnaître une vraie clé mal configurée.
- Un administrateur rétrogradé ou parti : ses clés cessent de fonctionner. Il
  faut en recréer au nom d'un administrateur actuel.

## 30. Compétences des agents

- Migrations : `skills`, `skills_enforcement` (`npm run db:migrate`, droits
  réappliqués), puis redémarrer l'API.
- Barre latérale › Compétences : créer, ajouter des fichiers, partager ; studio
  de l'agent › Compétences : les confier (10 au plus).
- Une compétence confidentielle impose un modèle local à l'agent ; elle n'est
  jamais proposée à un modèle externe.
- Suivi : `skill.create|update|delete|file_add|file_remove` (version,
  confidentialité ; jamais de contenu), étapes `use_skill` / `read_skill_file`
  dans les traces. Après une modification de compétence partagée, relire
  l'historique des versions si un agent change de comportement.
- Après ajout ou changement d'outils : relancer l'éval des agents
  (`npm run agent:eval`).
- Migrations `skill_originals` et `skill_originals_enforcement` (colonne chiffrée
  des modèles binaires) : `npm run db:migrate` (droits réappliqués), puis
  reconstruire l'image du bac à sable et redémarrer l'API.
- Modèles (DOCX, XLSX, PDF, PNG, JPEG, 2 Mio au plus) : marqués « modèle » dans la
  bibliothèque ; copiés à côté des scripts, jamais envoyés au modèle.
- Pièces jointes d'une conversation : un script les reçoit par leur nom, dans
  `inputs/` (5 au plus), seulement celles de la conversation en cours.
- Scripts (`.py`) : exécutés par l'outil `run_skill_script`, dans le bac à
  sable, seulement si l'agent a « Exécuter du code » (sinon le studio le
  signale). Ils comptent dans le quota « code » de l'organisation. Après une
  modification du bac à sable : `scripts/sandbox-attack.sh` (27 contrôles,
  dont 12 sur les scripts de compétence) ; en production, gVisor exigé.

## 29. Parité LibreChat (phase 1)

- Migrations à appliquer (`npm run db:migrate`, qui réapplique aussi les droits
  du rôle applicatif) : `message_author`, `preferences_theme_instructions`,
  `conversation_settings`, `continue_answer`, `sharing`, `sharing_enforcement`,
  `sharing_policies`. Puis redémarrer l'API.
- Changement de comportement : un **nouvel agent est privé** (son auteur et les
  administrateurs) ; le partager depuis son studio (« Accès »). Les agents
  existants et les prompts déjà partagés restent visibles de toute
  l'organisation (autorisation créée par la migration) ; la colonne
  `prompts.shared` disparaît.
- Groupes : Organisation › Membres et accès › Groupes (administrateurs).
- Un membre retiré perd ses partages ; réinvité, il repart de zéro.
- Thème clair : généré depuis les feuilles de style. Après une modification de
  CSS : `npm run theme -w @snowfall/web` (sinon `npm test` échoue) ; retouches à
  la main dans `apps/web/src/theme-light-fixes.css` uniquement.
- Suivi : `access.update` (forme du partage), `group.*`, `conversation.fork`,
  `attachment.copy`, `message.continue`, `conversation.compare_denied` — jamais
  de contenu, de nom ni de destinataire.

## 28 quater. Pseudonymisation

- Option d'organisation (Modèles et quotas), désactivée par défaut ; tracée
  (`security.pseudonymize_policy`). Sans effet sur un modèle local.
- Avant de l'activer pour tous : mesurer l'effet sur la qualité,
  `npm run agent:eval -- --model <fournisseur:modèle> --out avec.json --pseudonymize`
  puis la même commande sans l'option, et comparer (`--baseline`).

## 28 ter. Parcours sur la vraie pile

- `npm run e2e:real` : monte une pile jetable (projet compose `snowfall-e2e`,
  ports 55480, 58080, 3101, 55173), génère ses secrets, n'utilise jamais le
  `.env` du dépôt (fichier d'environnement dédié via `SNOWFALL_ENV_FILE`), joue
  le parcours, puis démonte tout. `--keep` laisse la pile en place pour regarder.
- Aucun fournisseur d'IA n'est appelé (modèle local de développement) : aucun
  quota consommé, aucune donnée ne sort.

## 28 bis. Données sensibles

- Activé par défaut (Organisation › Modèles et quotas › Protéger les données
  sensibles). Désactiver est tracé (`security.sensitive_policy`).
- Sans modèle local publié (fournisseur « local » autorisé et configuré), une
  donnée sensible bloque l'envoi : installer un modèle local avant d'ouvrir la
  plateforme à des services qui en manipulent (RH, paie, santé au travail).
- Suivi : `security.sensitive_detected` (catégories et action : `rerouted_local`,
  `kept_local`, `blocked`), jamais les valeurs.

## 28. Agents planifiés

- Le planificateur tourne dans chaque instance de l'API (chaque minute) ; une
  seule exécute une tâche donnée (bail de 20 minutes en base). Rien à démarrer.
- Une tâche échoue trois fois de suite : elle se met en pause (l'auteur la
  réactive). Audit : `agent.schedule_run` (statut, jamais le texte).
- L'en-tête `X-Snowfall-Internal` ne doit jamais traverser le proxy : vérifier
  qu'il est bien effacé (`infra/nginx/snowfall.conf`) après toute modification.

