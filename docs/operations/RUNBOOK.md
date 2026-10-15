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

## 2. KMS (HashiCorp Vault / OpenBao Transit)

Préparer la clé (une fois) :

```bash
vault secrets enable transit
vault write -f transit/keys/snowfall type=aes256-gcm96 derived=true
```

`derived=true` est obligatoire : chaque clé d'organisation est liée à un contexte
(organisation, version). La clé n'est jamais exportable.

Basculer une installation existante (aucune interruption) :

1. Renseigner `KMS_PROVIDER=vault`, `VAULT_ADDR` (HTTPS), `VAULT_TOKEN`
   (idéalement AppRole à durée courte), puis redémarrer l'API : les anciennes clés,
   enveloppées localement, restent lisibles.
2. `npm run keys:rotate -- --kek` : toutes les clés d'organisation sont
   rechiffrées par le KMS.
3. Conserver `SNOWFALL_MASTER_KEY` (sessions, cookie de connexion).

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
