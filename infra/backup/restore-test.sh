#!/bin/sh
# Snowfall — test de restauration (preuve exigée en audit ISO 27001 / SOC 2).
#
# Restaure la sauvegarde la plus récente (ou celle donnée) dans une base
# PostgreSQL temporaire démarrée dans ce conteneur, puis vérifie :
#   - les empreintes SHA-256 des fichiers chiffrés ;
#   - le déchiffrement (clé privée age dédiée au test, jamais la clé hors site) ;
#   - la restauration sans erreur ;
#   - le nombre de lignes de chaque table, identique au manifeste ;
#   - le nombre de migrations et l'absence de texte en clair dans les colonnes
#     chiffrées (échantillon).
# Écrit « restore_test_ok » (avec la durée : mesure du temps de reprise) ou
# « restore_test_failed ». Rien n'est conservé après le test.
#
#   restore-test.sh [dossier de sauvegarde]   (identité : BACKUP_IDENTITY_FILE)
set -eu
set -o pipefail

DIR="${BACKUP_DIR:-/backups}"
IDENTITY="${BACKUP_IDENTITY_FILE:-/run/secrets/backup_restore_identity}"
SOURCE="${1:-$(find "$DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort | tail -1)}"
WORK="$(mktemp -d)"
PGDATA="$WORK/data"
PORT=55432
started="$(date +%s)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "restore_test_failed source=$(basename "${SOURCE:-none}") reason=$1"; cleanup; exit 1; }
cleanup() {
  pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -n "$SOURCE" ] && [ -d "$SOURCE" ] || fail no_backup
[ -f "$IDENTITY" ] && [ -s "$IDENTITY" ] || fail no_identity
(cd "$SOURCE" && sha256sum -c SHA256SUMS >/dev/null 2>&1) || fail checksum

# Base jetable locale (socket dans le dossier de travail, aucun port exposé).
initdb -D "$PGDATA" -U restore --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/postgres.log" -w start >/dev/null || fail postgres_start
export PGHOST="$WORK" PGPORT="$PORT" PGUSER=restore

for dump in "$SOURCE"/*.dump.age; do
  db="$(basename "$dump" .dump.age)"
  # Clé de test valide et contenu authentique : le déchiffré commence par la
  # signature des dumps PostgreSQL (age vérifie aussi l'intégrité de bout en bout).
  magic="$(age --decrypt --identity "$IDENTITY" "$dump" 2>/dev/null | head -c 5 || true)"
  [ "$magic" = "PGDMP" ] || fail "decrypt_$db"
  createdb "$db"
  age --decrypt --identity "$IDENTITY" "$dump" | pg_restore -d "$db" --no-owner --no-privileges --exit-on-error \
    || fail "restore_$db"

  expected="$(cat "$SOURCE/$db.counts")"
  actual="$(psql -d "$db" -At -v ON_ERROR_STOP=1 -c "
    SELECT string_agg(format('%s.%s=%s', n.nspname, c.relname,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text), ' ' ORDER BY n.nspname, c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'")"
  [ "$expected" = "$actual" ] || fail "row_counts_$db"
done

migrations="$(grep '^migrations=' "$SOURCE/MANIFEST" | cut -d= -f2)"
restored="$(psql -d snowfall -At -c 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
[ "$migrations" = "$restored" ] || fail migrations

# Échantillon : les messages restaurés sont toujours chiffrés (« <version>:v1. »).
plaintext="$(psql -d snowfall -At -c "SELECT count(*) FROM (SELECT content FROM messages LIMIT 1000) m WHERE content !~ '^[0-9]+:v1\.'")"
[ "$plaintext" = "0" ] || fail plaintext_found

tables="$(grep -o '=' "$SOURCE/snowfall.counts" | wc -l)"
log "restore_test_ok source=$(basename "$SOURCE") tables=$tables migrations=$restored duration_s=$(( $(date +%s) - started ))"
