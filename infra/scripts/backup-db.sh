#!/usr/bin/env bash
# Sauvegarde chiffrée des bases snowfall et keycloak.
# Le dump ne touche jamais le disque en clair : pg_dump | age > fichier.age
#
#   BACKUP_AGE_RECIPIENT=age1... infra/scripts/backup-db.sh [dossier]
#
# La clé privée age doit être conservée hors du serveur (coffre, HSM, papier).
# La clé SNOWFALL_MASTER_KEY doit être sauvegardée séparément : sans elle, les
# messages restaurés restent chiffrés et illisibles.
set -euo pipefail

: "${BACKUP_AGE_RECIPIENT:?Définir BACKUP_AGE_RECIPIENT (clé publique age)}"
command -v age >/dev/null || { echo "age est requis : https://age-encryption.org" >&2; exit 1; }

CONTAINER="${SNOWFALL_DB_CONTAINER:-snowfall-postgres}"
OUT_DIR="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

umask 077
mkdir -p "$OUT_DIR"

for db in snowfall keycloak; do
  target="$OUT_DIR/${db}-${STAMP}.dump.age"
  # Superutilisateur : pg_dump refuse de sauvegarder des tables sous RLS
  # avec un rôle qui y serait soumis (sauvegarde silencieusement incomplète).
  docker exec "$CONTAINER" pg_dump -U snowfall -d "$db" --format=custom --no-owner \
    | age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$target"
  sha256sum "$target" > "$target.sha256"
  echo "Sauvegarde chiffrée : $target"
done
