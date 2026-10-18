# syntax=docker/dockerfile:1
# OCR local (Tesseract + Poppler) pour les documents numérisés.
#   docker build -t snowfall-ocr apps/ocr
# Lancé SANS réseau (network_mode: none), système de fichiers en lecture seule,
# dossier de travail en tmpfs ; l'API lui parle par un socket Unix.
FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

# Paquets Debian figés (versions de trixie) ; aucun outil réseau dans l'image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng poppler-utils \
  && rm -rf /var/lib/apt/lists/* \
  && for uid in 10101 10102; do \
       groupadd --gid "$uid" "ocr$uid" && useradd --uid "$uid" --gid "$uid" --no-create-home --shell /usr/sbin/nologin "ocr$uid"; \
     done \
  && groupadd --gid 10011 ocrapi

COPY server.py /opt/ocr/server.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# Root dans le conteneur, sans réseau et avec les seules capacités utiles
# (changer d'utilisateur, préparer le dossier, tuer les processus d'une lecture).
CMD ["python3", "-I", "/opt/ocr/server.py"]
