#!/usr/bin/env bash
# Restauration d'une sauvegarde chiffrée vers une base (de test de préférence).
#
#   infra/scripts/restore-db.sh <fichier.dump.age> <identité age> <base cible>
#
# À exercer régulièrement (test de restauration = preuve exigée en audit).
set -euo pipefail

FILE="${1:?Fichier .dump.age requis}"
IDENTITY="${2:?Fichier d'identité age (clé privée) requis}"
TARGET_DB="${3:?Base cible requise (ex. snowfall_restore_test)}"
CONTAINER="${SNOWFALL_DB_CONTAINER:-snowfall-postgres}"

if [ -f "$FILE.sha256" ]; then
  sha256sum --check "$FILE.sha256"
fi

docker exec "$CONTAINER" createdb -U snowfall "$TARGET_DB"
age --decrypt --identity "$IDENTITY" "$FILE" \
  | docker exec -i "$CONTAINER" pg_restore -U snowfall -d "$TARGET_DB" --no-owner --exit-on-error

echo "Restauré dans $TARGET_DB."
