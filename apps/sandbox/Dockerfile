# syntax=docker/dockerfile:1
# Bac à sable d'exécution de code (Python) pour les agents.
#   docker build -t snowfall-sandbox apps/sandbox
# Lancé SANS réseau (network_mode: none), système de fichiers en lecture seule,
# dossier de travail en tmpfs. En production : runtime gVisor (runsc) EXIGÉ,
# qui isole aussi du noyau de l'hôte (le serveur refuse de démarrer sans lui
# quand SANDBOX_REQUIRE_GVISOR=true, valeur de compose.prod.yaml).
FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

# Bibliothèques d'analyse figées ; aucun outil réseau ni compilateur dans l'image.
COPY requirements.txt /tmp/requirements.txt
# Deux utilisateurs d'exécution (un par emplacement) et le groupe du socket de l'API.
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements.txt \
  && rm /tmp/requirements.txt \
  && for uid in 10001 10002; do \
       groupadd --gid "$uid" "run$uid" && useradd --uid "$uid" --gid "$uid" --no-create-home --shell /usr/sbin/nologin "run$uid"; \
     done \
  && groupadd --gid 10010 sandboxapi

COPY server.py /opt/sandbox/server.py
# Polices et caches de matplotlib préparés au build (le système sera en lecture seule).
RUN MPLCONFIGDIR=/tmp/mpl python3 -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot" && rm -rf /tmp/mpl

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Root dans le conteneur, mais sans réseau et avec les seules capacités utiles
# (changer d'utilisateur, préparer le dossier, tuer les processus d'une exécution) :
# le code, lui, tourne sous l'utilisateur « runner ».
CMD ["python3", "-I", "/opt/sandbox/server.py"]
