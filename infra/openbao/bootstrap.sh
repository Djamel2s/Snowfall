#!/bin/sh
# Initialisation du KMS pour Snowfall (idempotent), à lancer une fois avec un
# jeton d'administration, depuis le conteneur OpenBao :
#
#   docker compose -f compose.yaml -f compose.prod.yaml exec \
#     -e BAO_TOKEN=<jeton admin> openbao sh /openbao/bootstrap/bootstrap.sh
#
# Crée : moteur Transit et clé « snowfall » (dérivée, non exportable),
# politique minimale de l'API, rôle AppRole à jetons courts limités au réseau
# interne. Écrit role_id et un secret_id dans /openbao/approle (0600), à
# transmettre à l'API (VAULT_ROLE_ID, VAULT_SECRET_ID_FILE), puis à effacer.
set -eu

: "${BAO_TOKEN:?Définir BAO_TOKEN (jeton d'administration)}"
export BAO_ADDR="${BAO_ADDR:-https://127.0.0.1:8200}"
BACKEND_CIDR="${SNOWFALL_BACKEND_CIDR:-172.31.0.0/24}"
OUT="${SNOWFALL_APPROLE_DIR:-/openbao/approle}"
HERE="$(dirname "$0")"

# Audit : déclaré dans config.hcl ; on vérifie seulement qu'il est actif.
bao audit list 2>/dev/null | grep -q 'stdout' || echo "ATTENTION : aucun journal d'audit actif (voir config.hcl)." >&2

# Transit : clé AES-256-GCM dérivée (contexte = organisation + version).
bao secrets list | grep -q '^transit/' || bao secrets enable transit
bao read transit/keys/snowfall >/dev/null 2>&1 || bao write -f transit/keys/snowfall type=aes256-gcm96 derived=true exportable=false allow_plaintext_backup=false
# Interdit toute suppression accidentelle de la clé.
bao write transit/keys/snowfall/config deletion_allowed=false >/dev/null

bao policy write snowfall-api "$HERE/snowfall-api.hcl"

bao auth list | grep -q '^approle/' || bao auth enable approle
# Jeton d'1 h renouvelable jusqu'à 24 h, utilisable uniquement depuis le
# réseau interne ; secret_id valable 30 jours (rotation : RUNBOOK §2).
bao write auth/approle/role/snowfall-api \
  token_policies=snowfall-api \
  token_ttl=1h token_max_ttl=24h \
  token_bound_cidrs="$BACKEND_CIDR" secret_id_bound_cidrs="$BACKEND_CIDR" \
  secret_id_ttl=720h secret_id_num_uses=0 token_type=service >/dev/null

umask 077
mkdir -p "$OUT"
bao read -field=role_id auth/approle/role/snowfall-api/role-id > "$OUT/role_id"
bao write -f -field=secret_id auth/approle/role/snowfall-api/secret-id > "$OUT/secret_id"
echo "AppRole prêt : $OUT/role_id et $OUT/secret_id (à transmettre à l'API, puis effacer d'ici)."
