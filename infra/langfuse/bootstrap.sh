#!/bin/sh
# Initialisation de Langfuse auto-hébergé (idempotent), depuis la racine du dépôt :
#
#   LANGFUSE_ADMIN_EMAIL=admin@exemple.fr sh infra/langfuse/bootstrap.sh
#
# 1. Génère les secrets dans infra/secrets/ (0600, jamais versionnés) : mots de
#    passe des bases, clés de chiffrement de Langfuse, clés du projet.
# 2. Démarre le stockage objet (Garage) : disposition à un nœud, compartiment
#    « langfuse », clé d'accès limitée à ce compartiment.
# 3. Démarre Langfuse, qui crée l'organisation, le projet « snowfall-agents »,
#    ses clés d'API et le compte administrateur.
#
# Ensuite : LANGFUSE_PUBLIC_KEY (affichée à la fin) dans l'environnement de
# l'API ; mot de passe administrateur dans infra/secrets/langfuse_admin_password,
# à changer à la première connexion.
set -eu
# Git Bash (Windows) : pas de conversion des chemins (/garage) en chemins Windows.
export MSYS_NO_PATHCONV=1

COMPOSE="${COMPOSE:-docker compose -f compose.yaml -f compose.prod.yaml -f compose.observability.yaml}"
SECRETS="${SNOWFALL_SECRETS_DIR:-infra/secrets}"
export SNOWFALL_SECRETS_DIR="$SECRETS"
ADMIN_EMAIL="${LANGFUSE_ADMIN_EMAIL:?Définir LANGFUSE_ADMIN_EMAIL (compte administrateur de Langfuse)}"

umask 077
mkdir -p "$SECRETS"

hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
# Écrit un secret une seule fois : relancer le script ne change rien.
once() { [ -s "$SECRETS/$1" ] || printf '%s' "$2" > "$SECRETS/$1"; }

once langfuse_db_password "$(hex 24)"
once langfuse_clickhouse_password "$(hex 24)"
once langfuse_redis_password "$(hex 24)"
once garage_rpc_secret "$(hex 32)"
once garage_admin_token "$(hex 32)"
once langfuse_s3_key_id "GK$(hex 12)"
once langfuse_s3_secret "$(hex 32)"
once langfuse_public_key "pk-lf-$(hex 16)"
once langfuse_secret_key "sk-lf-$(hex 24)"
once langfuse_admin_password "$(hex 12)"

read_secret() { cat "$SECRETS/$1"; }

# Fichiers d'environnement : chaque service ne reçoit que ses propres secrets.
printf 'CLICKHOUSE_PASSWORD=%s\n' "$(read_secret langfuse_clickhouse_password)" > "$SECRETS/langfuse-clickhouse.env"
printf 'requirepass %s\nappendonly yes\nprotected-mode yes\n' "$(read_secret langfuse_redis_password)" > "$SECRETS/langfuse-redis.conf"
[ -s "$SECRETS/langfuse.env" ] || cat > "$SECRETS/langfuse.env" <<EOF
DATABASE_URL=postgresql://langfuse:$(read_secret langfuse_db_password)@langfuse-db:5432/langfuse
SALT=$(hex 32)
ENCRYPTION_KEY=$(hex 32)
NEXTAUTH_SECRET=$(hex 32)
CLICKHOUSE_PASSWORD=$(read_secret langfuse_clickhouse_password)
REDIS_AUTH=$(read_secret langfuse_redis_password)
LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID=$(read_secret langfuse_s3_key_id)
LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY=$(read_secret langfuse_s3_secret)
LANGFUSE_S3_MEDIA_UPLOAD_ACCESS_KEY_ID=$(read_secret langfuse_s3_key_id)
LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY=$(read_secret langfuse_s3_secret)
LANGFUSE_INIT_ORG_ID=snowfall
LANGFUSE_INIT_ORG_NAME=Snowfall
LANGFUSE_INIT_PROJECT_ID=snowfall-agents
LANGFUSE_INIT_PROJECT_NAME=Agents Snowfall
LANGFUSE_INIT_PROJECT_PUBLIC_KEY=$(read_secret langfuse_public_key)
LANGFUSE_INIT_PROJECT_SECRET_KEY=$(read_secret langfuse_secret_key)
LANGFUSE_INIT_USER_EMAIL=$ADMIN_EMAIL
LANGFUSE_INIT_USER_NAME=Administrateur
LANGFUSE_INIT_USER_PASSWORD=$(read_secret langfuse_admin_password)
EOF

# Stockage objet : disposition, compartiment et clé (opérations idempotentes).
$COMPOSE up -d langfuse-s3
garage() { $COMPOSE exec -T langfuse-s3 /garage "$@"; }
i=0
until garage status >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -gt 30 ] && { echo "Garage ne répond pas." >&2; exit 1; }
  sleep 1
done
if ! garage layout show 2>/dev/null | grep -q 'zone'; then
  node="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c 10G "$node"
  garage layout apply --version 1
fi
garage bucket info langfuse >/dev/null 2>&1 || garage bucket create langfuse
garage key info langfuse >/dev/null 2>&1 || garage key import --yes -n langfuse "$(read_secret langfuse_s3_key_id)" "$(read_secret langfuse_s3_secret)"
# Droits limités au seul compartiment de Langfuse.
garage bucket allow --read --write --key langfuse langfuse >/dev/null

$COMPOSE up -d langfuse-db langfuse-clickhouse langfuse-redis langfuse-worker langfuse-web

echo
echo "Langfuse démarre sur http://127.0.0.1:3010 (boucle locale : tunnel SSH ou VPN)."
echo "Administrateur : $ADMIN_EMAIL — mot de passe dans $SECRETS/langfuse_admin_password (à changer)."
echo "Pour l'API : LANGFUSE_PUBLIC_KEY=$(read_secret langfuse_public_key)"
