# syntax=docker/dockerfile:1
# Service de décision local (Laya multilingue, Convai Innovations, Apache 2.0).
#   docker build -t snowfall-decision apps/decision
# Le modèle est téléchargé ET vérifié ici, au build (révision figée, SHA-256) ;
# à l'exécution : aucun réseau (network_mode: none), socket Unix, lecture seule.
FROM python:3.13.15-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b

# Dépendances figées avec leurs empreintes, toutes publiées depuis plus de deux semaines.
COPY requirements.txt /tmp/requirements.txt
# torch CPU vient de l'index PyTorch ; chaque fichier reste vérifié par son empreinte.
# /run/decision : un volume nommé en hérite les droits (l'API y entre par le groupe 10012).
RUN pip install --no-cache-dir --require-hashes --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple -r /tmp/requirements.txt && rm /tmp/requirements.txt \
  && groupadd --gid 10201 decision && useradd --uid 10201 --gid 10201 --no-create-home --shell /usr/sbin/nologin decision \
  && groupadd --gid 10012 decisionapi && usermod -aG decisionapi decision \
  && mkdir -p /run/decision && chown decision:decisionapi /run/decision && chmod 0750 /run/decision

ENV HF_HOME=/opt/models \
    LAYA_REPO=convaiinnovations/laya \
    LAYA_SUBFOLDER=multilingual \
    LAYA_REVISION=7b928d828b7b0e022f929d9bd2e44165aa270148 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Révision du 3 octobre 2026 ; les empreintes viennent du Hub (fichiers LFS).
COPY fetch_model.py /tmp/fetch_model.py
RUN python -I /tmp/fetch_model.py && rm /tmp/fetch_model.py && chmod -R a+rX /opt/models

COPY server.py /opt/decision/server.py
ENV HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER 10201
CMD ["python3", "-I", "/opt/decision/server.py"]
