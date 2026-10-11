# Snowfall

Plateforme de chat IA multi-tenant : API Fastify + LangGraph, front React,
authentification Keycloak, PostgreSQL.

## Prérequis
Node 24, npm 11, Docker.

## Démarrage
```bash
cp .env.example .env        # remplir les mots de passe
docker compose up -d        # PostgreSQL + Keycloak (realm importé automatiquement)
npm ci
npm run db:migrate
```
1. Console Keycloak (http://localhost:8080) → realm `snowfall` → créer un utilisateur.
2. Renseigner `SNOWFALL_BOOTSTRAP_SUBJECT` (id de l'utilisateur Keycloak) et
   `SNOWFALL_BOOTSTRAP_EMAIL` dans `.env`, puis `npm run db:bootstrap-test -w @snowfall/api`.
3. `npm run dev:api` et `npm run dev:web`.

## Qualité
`npm run check` (typecheck, tests, build, lint). Les tests d'intégration
nécessitent `TEST_DATABASE_URL`.

## Sécurité
Voir `docs/security/SECURITY_BASELINE.md`.