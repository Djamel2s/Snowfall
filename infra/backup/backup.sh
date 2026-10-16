#!/bin/sh
# Snowfall — sauvegarde chiffrée planifiée des bases snowfall et keycloak.
#
# - pg_dump par un rôle en lecture seule (snowfall_backup, BYPASSRLS) ;
# - chiffré à la volée pour une ou plusieurs clés publiques age (la clé
#   privée n'est jamais sur le serveur) : jamais de dump en clair sur disque ;
# - manifeste (empreintes SHA-256, nombre de lignes par table) pour vérifier
#   la restauration ;
# - copie hors site facultative (rclone : S3 avec verrouillage d'objet,
#   SFTP…) puis rétention locale ;
# - une ligne « backup_ok » ou « backup_failed » par exécution (alertes Loki).
#
# Variables : BACKUP_DB_HOST, BACKUP_DB_PASSWORD_FILE, BACKUP_RECIPIENTS_FILE,
# BACKUP_DIR, BACKUP_HOUR (UTC), BACKUP_KEEP_DAYS, BACKUP_REMOTE (rclone),
# BACKUP_RUN_ONCE=true pour une exécution unique.
set -eu
set -o pipefail

DB_HOST="${BACKUP_DB_HOST:-db}"
DB_USER="${BACKUP_DB_USER:-snowfall_backup}"
DIR="${BACKUP_DIR:-/backups}"
RECIPIENTS="${BACKUP_RECIPIENTS_FILE:-/run/secrets/backup_recipients}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-35}"
HOUR="${BACKUP_HOUR:-02}"
DATABASES="${BACKUP_DATABASES:-snowfall keycloak}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

[ -s "$RECIPIENTS" ] || { log "backup_failed reason=no_recipients"; exit 1; }
export PGPASSWORD="$(cat "${BACKUP_DB_PASSWORD_FILE:-/run/secrets/backup_db_password}")"
export PGHOST="$DB_HOST" PGUSER="$DB_USER" PGCONNECT_TIMEOUT=10 PGSSLMODE="${BACKUP_DB_SSLMODE:-prefer}"

run_once() {
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target="$DIR/$stamp"
  umask 077
  mkdir -p "$target.partial"
  started="$(date +%s)"

  for db in $DATABASES; do
    # Comptage exact par table, lu dans la même base (preuve pour la restauration).
    psql -d "$db" -At -v ON_ERROR_STOP=1 -c "
      SELECT string_agg(format('%s.%s=%s', n.nspname, c.relname,
             (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text), ' ' ORDER BY n.nspname, c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'" \
      > "$target.partial/$db.counts"

    pg_dump -d "$db" --format=custom --no-owner --no-privileges --compress=6 \
      | age --encrypt --recipients-file "$RECIPIENTS" --output "$target.partial/$db.dump.age"
  done

  (cd "$target.partial" && sha256sum ./*.dump.age > SHA256SUMS)
  {
    echo "created=$stamp"
    echo "postgres=$(psql -d snowfall -At -c 'SHOW server_version')"
    echo "migrations=$(psql -d snowfall -At -c 'SELECT count(*) FROM drizzle.__drizzle_migrations' 2>/dev/null || echo unknown)"
    echo "duration_seconds=$(( $(date +%s) - started ))"
  } > "$target.partial/MANIFEST"
  mv "$target.partial" "$target"

  if [ -n "${BACKUP_REMOTE:-}" ]; then
    rclone copy --immutable --checksum "$target" "$BACKUP_REMOTE/$stamp"
  fi

  # Rétention locale (la copie distante suit sa propre politique de verrouillage).
  find "$DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$KEEP_DAYS" -exec rm -rf {} +

  size="$(du -sk "$target" | cut -f1)"
  log "backup_ok stamp=$stamp size_kb=$size duration_s=$(( $(date +%s) - started )) remote=${BACKUP_REMOTE:+yes}"
}

attempt() {
  if run_once; then return 0; fi
  log "backup_failed stamp=$(date -u +%Y%m%dT%H%M%SZ)"
  rm -rf "$DIR"/*.partial
  return 1
}

if [ "${BACKUP_RUN_ONCE:-false}" = "true" ]; then
  attempt
  exit $?
fi

log "Planification : chaque jour à ${HOUR}h UTC, rétention ${KEEP_DAYS} jours."
while true; do
  now="$(date -u +%s)"
  next="$(date -u -d "$(date -u +%Y-%m-%d) ${HOUR}:00:00" +%s 2>/dev/null || date -u -D '%Y-%m-%d %H:%M:%S' -d "$(date -u +%Y-%m-%d) ${HOUR}:00:00" +%s)"
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  attempt || true
done
