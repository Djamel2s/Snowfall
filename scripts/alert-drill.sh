#!/usr/bin/env bash
# Exercice d'alerte de bout en bout (preuve d'exploitation) : sur un réseau
# Docker jetable, avec les VRAIES règles et la VRAIE configuration de Prometheus
# et de Loki, et le routage d'Alertmanager :
#   1. panne de l'API (son point de métriques s'arrête) → SnowfallApiInjoignable ;
#   2. sauvegarde échouée (ligne « backup_failed » dans les journaux) → SauvegardeEchouee ;
# jusqu'à l'e-mail reçu (Mailpit jetable). Mesure le délai de chaque alerte.
# Rien ne touche la pile de développement ni la production ; tout est supprimé à la fin.
#
#   scripts/alert-drill.sh            → lignes « drill_ok alert=… delay_s=… » (preuve à conserver)
set -euo pipefail
export MSYS_NO_PATHCONV=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROM="prom/prometheus:v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e"
AM="prom/alertmanager:v0.34.1@sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a"
LOKI="grafana/loki:3.7.8@sha256:1107dd5274e0ada47e42472b7a7e71f3b2a2fe878878108f3e2f9e51528f0193"
MAILPIT="axllent/mailpit:v1.31.2@sha256:74d609a42ec279aa63c6b4622a6fa9b5408d1ad5b1d76a1c4be40a265ce0863d"
ID="drill$$"
NET="snowfall-$ID"
WORK="$(mktemp -d)"
# Chemin vu par Docker (Git Bash sous Windows : C:/…).
WORK_DOCKER="$(cd "$WORK" && (pwd -W 2>/dev/null || pwd))"
MAIL_PORT="${DRILL_MAIL_PORT:-18025}"
LOKI_PORT="${DRILL_LOKI_PORT:-13100}"
TIMEOUT="${DRILL_TIMEOUT_S:-420}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
cleanup() {
  docker rm -f "$ID-prometheus" "$ID-alertmanager" "$ID-loki" "$ID-mailpit" "$ID-api" >/dev/null 2>&1 || true
  docker network rm "$NET" "$NET-out" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Routage de production, envoi vers le Mailpit jetable (aucun secret, aucun TLS).
mkdir -p "$WORK/alertmanager" "$WORK/secrets"
sed -n '/^route:/,$p' "$ROOT/infra/monitoring/alertmanager/alertmanager.yml" > "$WORK/alertmanager/route.yml"
{
  echo 'global:'
  echo '  smtp_smarthost: "mailpit:1025"'
  echo '  smtp_from: "alertes@drill.test"'
  echo '  smtp_require_tls: false'
  sed 's/exploitation@exemple.com/exploitation@drill.test/' "$WORK/alertmanager/route.yml"
} > "$WORK/alertmanager/alertmanager.yml"
echo drill-token > "$WORK/secrets/metrics_token"
chmod -R a+rX "$WORK"

docker network create --internal "$NET" >/dev/null
# Mailpit (lecture des e-mails) et Loki (écriture des journaux) : seuls ports
# publiés, sur la boucle locale, par un second réseau ; le reste est interne.
docker network create "$NET-out" >/dev/null
docker run -d --name "$ID-mailpit" --network "$NET-out" -p "127.0.0.1:$MAIL_PORT:8025" "$MAILPIT" >/dev/null
docker network connect --alias mailpit "$NET" "$ID-mailpit"
docker run -d --name "$ID-loki" --network "$NET-out" -p "127.0.0.1:$LOKI_PORT:3100" --tmpfs /loki:uid=10001,gid=10001   -v "$ROOT/infra/monitoring/loki/loki.yaml:/etc/loki/loki.yaml:ro" -v "$ROOT/infra/monitoring/loki/rules:/etc/loki/rules:ro" "$LOKI"   -config.file=/etc/loki/loki.yaml >/dev/null
docker network connect --alias loki "$NET" "$ID-loki"
docker run -d --name "$ID-api" --network "$NET" --network-alias api --tmpfs /prometheus:uid=65534,gid=65534 "$PROM"   --config.file=/etc/prometheus/prometheus.yml --web.listen-address=:9464 --storage.tsdb.path=/prometheus >/dev/null
docker run -d --name "$ID-alertmanager" --network "$NET" --network-alias alertmanager --tmpfs /alertmanager:uid=65534,gid=65534   -v "$WORK_DOCKER/alertmanager:/etc/alertmanager:ro" "$AM" --config.file=/etc/alertmanager/alertmanager.yml --storage.path=/alertmanager >/dev/null
docker run -d --name "$ID-prometheus" --network "$NET" --tmpfs /prometheus:uid=65534,gid=65534   -v "$ROOT/infra/monitoring/prometheus:/etc/prometheus:ro" -v "$WORK_DOCKER/secrets/metrics_token:/run/secrets/metrics_token:ro" "$PROM"   --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/prometheus >/dev/null

wait_for() { # $1 = description, $2 = commande
  local until=$(( $(date +%s) + 180 ))
  until eval "$2" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$until" ] || { log "drill_failed reason=$1"; exit 1; }
    sleep 2
  done
}
wait_for mailpit "curl -fs http://127.0.0.1:$MAIL_PORT/api/v1/messages"
wait_for loki "curl -fs http://127.0.0.1:$LOKI_PORT/ready"

mail_for() { curl -fs "http://127.0.0.1:$MAIL_PORT/api/v1/messages" | grep -q "$1"; }
await_mail() { # $1 = alerte, $2 = début (secondes)
  local until=$(( $2 + TIMEOUT ))
  while ! mail_for "$1"; do
    [ "$(date +%s)" -lt "$until" ] || { log "drill_failed alert=$1 reason=no_mail_after_${TIMEOUT}s"; exit 1; }
    sleep 5
  done
  log "drill_ok alert=$1 delay_s=$(( $(date +%s) - $2 ))"
}

# L'API répond d'abord (Prometheus la voit « up »), puis tombe.
log "drill_start network=$NET"
sleep 70
api_down="$(date +%s)"
docker stop "$ID-api" >/dev/null
log "panne simulée : arrêt du point de métriques de l'API"

# Sauvegarde échouée : la ligne qu'écrit backup.sh, avec l'étiquette posée par Alloy.
backup_failed="$(date +%s)"
now_ns="$(date +%s)000000000"
curl -fs -H 'Content-Type: application/json' "http://127.0.0.1:$LOKI_PORT/loki/api/v1/push" \
  -d "{\"streams\":[{\"stream\":{\"service\":\"snowfall-backup-1\"},\"values\":[[\"$now_ns\",\"$(date -u +%Y-%m-%dT%H:%M:%SZ) backup_failed stamp=drill\"]]}]}" \
  || { log "drill_failed reason=loki_push"; exit 1; }
log "panne simulée : sauvegarde échouée (journal)"

await_mail SauvegardeEchouee "$backup_failed"
await_mail SnowfallApiInjoignable "$api_down"
log "drill_done"
