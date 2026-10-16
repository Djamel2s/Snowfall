# Snowfall — sauvegardes : pg_dump (même version que la base), age, rclone.
# Les binaires PostgreSQL servent aussi au test de restauration (base
# temporaire démarrée dans le conteneur).
FROM postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

RUN apk upgrade --no-cache && apk add --no-cache age rclone tini

COPY --chmod=0555 backup.sh restore-test.sh /usr/local/bin/

# Utilisateur non privilégié (uid 70 = postgres dans l'image Alpine).
USER 70:70
WORKDIR /tmp
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["backup.sh"]
