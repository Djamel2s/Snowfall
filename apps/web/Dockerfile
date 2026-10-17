# syntax=docker/dockerfile:1
# Interface web servie par nginx (CSP stricte, TLS, proxy de l'API).
#   docker build -f apps/web/Dockerfile -t snowfall-web .

FROM node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @snowfall/web --include-workspace-root --no-audit --no-fund
COPY apps/web apps/web
RUN npm run build --workspace @snowfall/web

FROM nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
# Correctifs de sécurité des paquets système, puis nginx sans privilèges :
# pas de directive "user", PID et fichiers temporaires dans des répertoires
# accessibles à l'utilisateur nginx.
RUN apk upgrade --no-cache \
  && rm /etc/nginx/conf.d/default.conf \
  && sed -i -e '/^user /d' -e 's,^pid .*,pid /tmp/nginx.pid;,' /etc/nginx/nginx.conf \
  && chown -R nginx:nginx /var/cache/nginx
COPY infra/nginx/snowfall.conf /etc/nginx/conf.d/snowfall.conf
COPY infra/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY infra/nginx/artifact-headers.conf /etc/nginx/snippets/artifact-headers.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080 8443
