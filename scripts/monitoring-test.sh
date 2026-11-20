#!/usr/bin/env bash
# Vérifie la supervision sans rien démarrer d'autre que les outils officiels :
#   - syntaxe des alertes Prometheus et tests unitaires (promtool) ;
#   - configuration d'Alertmanager (amtool) ;
#   - configuration de Loki (loki -verify-config : ne lit PAS les règles ;
#     elles sont prouvées par scripts/alert-drill.sh, qui les fait déclencher).
# Mêmes images (et empreintes) que la production. Utilisé par la CI.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROM="prom/prometheus:v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e"
AM="prom/alertmanager:v0.34.1@sha256:e9733bafb1bdef9b00e25a21f8f99dc26a22224bf16641ad754d1649f4c3357a"
LOKI="grafana/loki:3.7.8@sha256:1107dd5274e0ada47e42472b7a7e71f3b2a2fe878878108f3e2f9e51528f0193"
# Git Bash (Windows) : pas de conversion des chemins des conteneurs.
export MSYS_NO_PATHCONV=1

run() { docker run --rm --network none --read-only --tmpfs /tmp "$@"; }

echo "== Prometheus : règles"
run -v "$ROOT/infra/monitoring/prometheus:/rules:ro" --entrypoint promtool "$PROM" check rules /rules/alerts.yml
echo "== Prometheus : tests des alertes"
run -v "$ROOT/infra/monitoring/prometheus:/rules:ro" -w /rules --entrypoint promtool "$PROM" test rules alerts.test.yml
echo "== Alertmanager : configuration"
# Le secret SMTP n'existe pas ici : un fichier factice le remplace (lecture seule).
run -v "$ROOT/infra/monitoring/alertmanager:/etc/alertmanager:ro" --tmpfs /run/secrets \
  --entrypoint sh "$AM" -c 'echo test > /run/secrets/alertmanager_smtp_password && amtool check-config /etc/alertmanager/alertmanager.yml'
echo "== Loki : configuration et règles"
run -v "$ROOT/infra/monitoring/loki/loki.yaml:/etc/loki/loki.yaml:ro" -v "$ROOT/infra/monitoring/loki/rules:/etc/loki/rules:ro" --tmpfs /loki \
  "$LOKI" -config.file=/etc/loki/loki.yaml -verify-config
echo "Supervision : tout est valide."
