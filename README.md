# Snowfall

Plateforme de chat IA multi-tenant : API Fastify + LangGraph (BFF OIDC), front React,
authentification Keycloak, PostgreSQL (RLS + chiffrement applicatif).

## Prérequis
Node 24, npm 11, Docker.

## Démarrage
```bash
cp .env.example .env              # remplir chaque secret (commandes en tête du fichier)
docker compose up -d db
npm ci
npm run db:setup                  # rôles PostgreSQL à moindre privilège + base Keycloak
npm run db:migrate                # migrations (compte migrator) + droits du rôle applicatif
docker compose up -d keycloak     # realm durci importé automatiquement
```
1. Console Keycloak (http://localhost:8080) → realm `snowfall` → créer un utilisateur
   (cocher « Email verified » tant qu'aucun SMTP n'est configuré). La double
   authentification TOTP est imposée à la première connexion.
2. Renseigner `SNOWFALL_BOOTSTRAP_SUBJECT` (id de l'utilisateur Keycloak) et
   `SNOWFALL_BOOTSTRAP_EMAIL` dans `.env`, puis `npm run db:bootstrap-test -w @snowfall/api`.
3. `npm run dev:api` et `npm run dev:web`.

### Migration d'une installation existante
Le realm n'est importé que s'il n'existe pas : supprimer le conteneur Keycloak
(l'ancienne base H2 interne disparaît avec lui), puis suivre « Démarrage ».
Recréer l'utilisateur Keycloak, et rattacher son nouvel id
(`UPDATE external_identities SET subject = '<nouvel id>'`, avec le compte de migration).
Les données déjà en base sont chiffrées par `npm run db:encrypt-existing -w @snowfall/api`.

## Production
`docker compose -f compose.yaml -f compose.prod.yaml up -d` (TLS, Keycloak en mode
`start`, aucun port base exposé). `DATABASE_URL` doit utiliser `sslmode=verify-full`.
Sauvegardes chiffrées : `infra/scripts/backup-db.sh` / `restore-db.sh` (outil `age`).

## Qualité
`npm run check` (typecheck, tests, build, lint). Les tests d'intégration
nécessitent `TEST_DATABASE_URL` (rôle applicatif) et `TEST_DATABASE_MIGRATION_URL`.

## Sécurité
Voir `docs/security/SECURITY_BASELINE.md`.
