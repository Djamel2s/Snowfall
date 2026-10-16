# Snowfall — Runbook d'exploitation

Procédures pour les opérateurs de la plateforme. Toutes les commandes se lancent
depuis la racine du dépôt, avec le fichier `.env` (développement) ou les secrets
injectés par le gestionnaire (production).

## 1. Mise à jour d'une installation existante

```bash
npm run db:migrate        # nouvelles tables, fonctions, droits du rôle applicatif
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
| Compromission supposée d'une organisation | `npm run keys:rotate -- --dek --org <uuid> --reencrypt` |

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
