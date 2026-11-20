# syntax=docker/dockerfile:1
# Bac à sable d'exécution de code (Python) pour les agents.
#   docker build -t snowfall-sandbox apps/sandbox
# Lancé SANS réseau (network_mode: none), système de fichiers en lecture seule,
# dossier de travail en tmpfs. En production : runtime gVisor (runsc) EXIGÉ,
# qui isole aussi du noyau de l'hôte (le serveur refuse de démarrer sans lui
# quand SANDBOX_REQUIRE_GVISOR=true, valeur de compose.prod.yaml).
FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

# Documents : LibreOffice sans interface (Word, PowerPoint, Excel → PDF, recalcul
# des formules) et des polices (Carlito et Caladea : mêmes mesures que Calibri et
# Cambria, la mise en page d'un document Office ne bouge pas en PDF ; Inter, Noto
# pour les autres écritures). Paquets Debian signés, base figée par son empreinte ;
# versions non épinglées : Debian retire une version dès son correctif de sécurité.
RUN apt-get update   && apt-get install -y --no-install-recommends        libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui        fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation fonts-dejavu-core fonts-inter fonts-noto-core   && apt-get purge -y --auto-remove   && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man   && fc-cache -f

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
# Module de documents (thèmes, présentations, rapports, classeurs, PDF).
COPY snowfall_docs /usr/local/lib/python3.13/site-packages/snowfall_docs
# Cache des polices de matplotlib préparé au build, copié dans chaque exécution
# (le système est en lecture seule ; sans lui, chaque exécution relirait les polices).
RUN MPLCONFIGDIR=/opt/mpl python3 -c "import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot; from matplotlib import font_manager; font_manager.findfont('Carlito')"   && chmod -R a+rX /opt/mpl   && python3 -c "import snowfall_docs" 

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Root dans le conteneur, mais sans réseau et avec les seules capacités utiles
# (changer d'utilisateur, préparer le dossier, tuer les processus d'une exécution) :
# le code, lui, tourne sous l'utilisateur « runner ».
CMD ["python3", "-I", "/opt/sandbox/server.py"]
