#!/usr/bin/env bash
# Exercice de sauvegarde et de restauration (preuve d'exploitation), de bout en
# bout, sur une base PostgreSQL JETABLE (jamais celle du poste ni de la production) :
#   1. base migrée, rôles à moindre privilège, données de référence chiffrées ;
#   2. sauvegarde par le VRAI service (infra/backup, rôle en lecture seule,
#      chiffrement age vers deux clés publiques) ;
#   3. test de restauration du service (restore-test.sh : empreintes, lignes, migrations) ;
#   4. restauration réelle dans une nouvelle base, selon le RUNBOOK (§ 13),
#      droits réappliqués (db:migrate), puis relecture par l'application :
#      rôle applicatif, RLS active, contenu déchiffré identique à l'original.
# Mesure le temps de reprise (RTO) de l'étape 4. Tout est supprimé à la fin.
#
#   scripts/restore-drill.sh   → lignes « backup_ok », « restore_test_ok », « drill_restore_ok rto_s=… »
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG="postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24"
ID="restore-drill$$"
PORT="${DRILL_PG_PORT:-55433}"
WORK="$(mktemp -d)"
# Chemin vu par Docker (Git Bash sous Windows : C:/…).
WORK_DOCKER="$(cd "$WORK" && (pwd -W 2>/dev/null || pwd))"
secret() { head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24; }
SUPER="$(secret)"; MIGRATOR="$(secret)"; APP="$(secret)"; BACKUP="$(secret)"; KEYCLOAK="$(secret)"
MASTER="$(head -c 32 /dev/urandom | base64)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cleanup() {
  docker rm -f "$ID-db" >/dev/null 2>&1 || true
  docker network rm "$ID" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

env_for() { # $1 = base
  cat <<EOF
NODE_ENV=test
DATABASE_ADMIN_URL=postgresql://snowfall:$SUPER@127.0.0.1:$PORT/$1
DATABASE_MIGRATION_URL=postgresql://snowfall_migrator:$MIGRATOR@127.0.0.1:$PORT/$1
DATABASE_URL=postgresql://snowfall_app:$APP@127.0.0.1:$PORT/$1
KEYCLOAK_DB_PASSWORD=$KEYCLOAK
BACKUP_DB_PASSWORD=$BACKUP
SNOWFALL_MASTER_KEY=$MASTER
EOF
}
with_env() { # $1 = fichier d'environnement ; le reste : commande (dans apps/api)
  local file="$1"; shift
  # Chemin natif pour Node (dotenv) : sous Git Bash, « /tmp » n'est pas le même dossier.
  local native; native="$(cd "$(dirname "$file")" && (pwd -W 2>/dev/null || pwd))/$(basename "$file")"
  (cd "$ROOT/apps/api" && set -a && . "$file" && set +a && SNOWFALL_ENV_FILE="$native" "$@")
}

# 1. Base jetable, migrée, avec des données de référence chiffrées.
docker network create "$ID" >/dev/null
docker run -d --name "$ID-db" --network "$ID" --network-alias db -e POSTGRES_DB=snowfall -e POSTGRES_USER=snowfall -e POSTGRES_PASSWORD="$SUPER" \
  -p "127.0.0.1:$PORT:5432" "$PG" >/dev/null
until docker exec "$ID-db" pg_isready -U snowfall -q 2>/dev/null; do sleep 1; done
sleep 2
env_for snowfall > "$WORK/source.env"
with_env "$WORK/source.env" npx tsx scripts/db-setup.ts >/dev/null
with_env "$WORK/source.env" npm run --silent db:migrate >/dev/null
with_env "$WORK/source.env" npx tsx scripts/restore-drill-data.ts seed "$WORK_DOCKER/reference.json"

# 2. Sauvegarde par le service réel : deux clés age (« hors site » et « test »).
docker build -q -t "snowfall-backup:$ID" "$(cd "$ROOT/infra/backup" && (pwd -W 2>/dev/null || pwd))" >/dev/null
mkdir -p "$WORK/backups" "$WORK/secrets"
chmod 777 "$WORK/backups"
for name in offsite test; do
  docker run --rm --entrypoint age-keygen "snowfall-backup:$ID" 2>/dev/null > "$WORK/secrets/$name.key"
done
grep -h '^# public key:' "$WORK/secrets/offsite.key" "$WORK/secrets/test.key" | sed 's/^# public key: //' > "$WORK/secrets/backup_recipients"
grep -v '^#' "$WORK/secrets/test.key" > "$WORK/secrets/backup_restore_identity"
printf '%s' "$BACKUP" > "$WORK/secrets/backup_db_password"
chmod 644 "$WORK/secrets/"*
docker run --rm --network "$ID" \
  -e BACKUP_RUN_ONCE=true -e BACKUP_DATABASES=snowfall -e BACKUP_DB_HOST=db -e BACKUP_DB_SSLMODE=disable \
  -e BACKUP_DB_PASSWORD_FILE=/run/secrets/backup_db_password -e BACKUP_RECIPIENTS_FILE=/run/secrets/backup_recipients \
  -v "$WORK_DOCKER/secrets:/run/secrets:ro" -v "$WORK_DOCKER/backups:/backups" "snowfall-backup:$ID"

# 3. Test de restauration du service (clé de test seulement).
docker run --rm --read-only --tmpfs /tmp -e BACKUP_IDENTITY_FILE=/run/secrets/backup_restore_identity \
  -v "$WORK_DOCKER/secrets:/run/secrets:ro" -v "$WORK_DOCKER/backups:/backups:ro" "snowfall-backup:$ID" restore-test.sh

# Aucun dump en clair : les fichiers sauvegardés sont tous chiffrés (age).
backup_dir="$(find "$WORK/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | head -1)"
if grep -rqa "plafond de la note de frais" "$backup_dir"; then log "drill_failed reason=plaintext_in_backup"; exit 1; fi

# 4. Restauration réelle (clé hors site), dans une nouvelle base, chronométrée.
started="$(date +%s)"
docker exec "$ID-db" createdb -U snowfall snowfall_restored
docker run --rm --network "$ID" -e PGPASSWORD="$SUPER" \
  -v "$WORK_DOCKER/secrets:/run/secrets:ro" -v "$WORK_DOCKER/backups:/backups:ro" --entrypoint sh "snowfall-backup:$ID" -c \
  "age --decrypt --identity /run/secrets/offsite.key /backups/$(basename "$backup_dir")/snowfall.dump.age \
   | pg_restore -h db -U snowfall -d snowfall_restored --no-owner --exit-on-error"
# Propriétés et droits (le dump n'en porte pas) : db:setup rend les objets au
# compte de migration, db:migrate réapplique les droits de l'API (RUNBOOK § 13).
env_for snowfall_restored > "$WORK/restored.env"
with_env "$WORK/restored.env" npx tsx scripts/db-setup.ts >/dev/null
with_env "$WORK/restored.env" npm run --silent db:migrate 2>&1 | grep -E "Error|error|✗" && { log "drill_failed reason=migrate_restored"; exit 1; }
with_env "$WORK/restored.env" npx tsx scripts/restore-drill-data.ts verify "$WORK_DOCKER/reference.json"
log "drill_restore_ok rto_s=$(( $(date +%s) - started )) source=$(basename "$backup_dir")"

# Sans la clé maître, les données restaurées restent illisibles.
sed -i "s|^SNOWFALL_MASTER_KEY=.*|SNOWFALL_MASTER_KEY=$(head -c 32 /dev/urandom | base64)|" "$WORK/restored.env"
# L'échec attendu est celui du déchiffrement (pas une autre erreur).
if with_env "$WORK/restored.env" npx tsx scripts/restore-drill-data.ts verify "$WORK_DOCKER/reference.json" > "$WORK/wrong-key.log" 2>&1   || ! grep -q "DECRYPTION_FAILED" "$WORK/wrong-key.log"; then
  log "drill_failed reason=readable_without_master_key"; cat "$WORK/wrong-key.log" | tail -3; exit 1
fi
log "drill_wrong_key_ok (données restaurées illisibles sans la clé maître)"
docker rmi "snowfall-backup:$ID" >/dev/null 2>&1 || true
