# syntax=docker/dockerfile:1
# API Snowfall. Construire depuis la racine du dépôt :
#   docker build -f apps/api/Dockerfile --target runtime -t snowfall-api .
#   docker build -f apps/api/Dockerfile --target migrate -t snowfall-migrate .
# Images de base figées par digest (mises à jour par Dependabot).

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @snowfall/api --include-workspace-root=false --no-audit --no-fund
COPY apps/api apps/api
RUN npm run build --workspace @snowfall/api

# Migrations (drizzle-kit, outil de développement) : tâche ponctuelle, lancée
# avec le compte de migration avant chaque déploiement.
FROM build AS migrate
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "db:migrate", "--workspace", "@snowfall/api"]

FROM build AS prune
RUN npm prune --omit=dev --workspace @snowfall/api --include-workspace-root=false \
  && mkdir -p apps/api/node_modules

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001
# Correctifs de sécurité des paquets système publiés depuis l'image de base ;
# npm et corepack retirés : inutiles à l'exécution, surface d'attaque en moins.
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
            /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
COPY --from=prune --chown=root:root /app/node_modules ./node_modules
# Dépendances propres à l'espace de travail (versions distinctes de la racine).
COPY --from=prune --chown=root:root /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prune --chown=root:root /app/apps/api/package.json ./apps/api/package.json
COPY --from=prune --chown=root:root /app/apps/api/dist ./apps/api/dist
# Catalogue d'agents (données : fiches, prompts, compétences, jeux d'évaluation).
COPY --from=prune --chown=root:root /app/apps/api/catalog ./apps/api/catalog
# Code et dépendances en lecture seule pour le processus (utilisateur non root).
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1
CMD ["node", "apps/api/dist/server.js"]
