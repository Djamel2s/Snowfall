#!/usr/bin/env bash
# Construit le bac à sable, le lance durci COMME EN PRODUCTION (compose.prod.yaml,
# service « sandbox »), puis l'attaque (apps/sandbox/attack_test.py) depuis un
# conteneur client qui a seulement accès au socket, comme l'API.
#
#   scripts/sandbox-attack.sh            # runtime par défaut (runc)
#   SANDBOX_RUNTIME=runsc scripts/sandbox-attack.sh   # avec gVisor installé
#
# Tout est jetable : conteneurs et volume supprimés à la fin.
set -euo pipefail

# Chemin vu par Docker (sous Git Bash pour Windows : C:/…, pas /c/…).
ROOT="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
RUNTIME="${SANDBOX_RUNTIME:-runc}"
NAME="snowfall-sandbox-attack-$$"
VOLUME="snowfall-sandbox-attack-$$"
REQUIRE="false"
[ "$RUNTIME" = "runsc" ] && REQUIRE="true"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

export MSYS_NO_PATHCONV=1
docker build -q -t snowfall-sandbox:attack "$ROOT/apps/sandbox" >/dev/null
docker volume create "$VOLUME" >/dev/null

docker run -d --name "$NAME" \
  --runtime "$RUNTIME" \
  --init \
  --network none \
  --read-only \
  --cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add KILL --cap-add CHOWN \
  --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 2g --cpus 2 \
  --tmpfs /work:size=256m,mode=0711 \
  --tmpfs /tmp:size=16m,mode=0700 \
  --tmpfs /dev/shm:size=16m,mode=0700 \
  -e SANDBOX_REQUIRE_GVISOR="$REQUIRE" \
  -v "$VOLUME:/run/sandbox" \
  snowfall-sandbox:attack >/dev/null

for _ in $(seq 1 30); do
  docker logs "$NAME" 2>&1 | grep -q "prêt" && break
  sleep 1
done

# Client : même image (Python présent), sans réseau, groupe du socket comme l'API.
docker run --rm --network none --read-only --cap-drop ALL \
  --user 20000:20000 --group-add 10010 \
  -v "$VOLUME:/run/sandbox" \
  -v "$ROOT/apps/sandbox/attack_test.py:/attack_test.py:ro" \
  --entrypoint python3 snowfall-sandbox:attack -I /attack_test.py /run/sandbox/sandbox.sock
