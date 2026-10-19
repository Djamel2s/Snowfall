"""Tests du service de décision, dans son image, sans réseau (CI).

  docker run --rm --network none --read-only --tmpfs /run/decision:uid=10201,gid=10012,mode=0750 --tmpfs /tmp \
    -v "$PWD/apps/decision:/t:ro" -v "$PWD/apps/api/src/decision:/cases:ro" \
    snowfall-decision:ci python3 -I /t/decision_test.py

Vérifie : identité non-root, aucun réseau, socket 0660, entrées hostiles
refusées, et la mesure du routage sur le jeu de test tenu à l'écart (garde-fou
contre une régression du modèle ou de la question).
"""

import http.client
import json
import os
import re
import socket
import stat
import subprocess
import sys
import time

SOCKET = "/run/decision/decision.sock"
# Mêmes valeurs que apps/api/src/decision/routing.ts.
THRESHOLD = 0.83
QUESTION = {
    "instructions": "Cette demande exige-t-elle un raisonnement approfondi, une rédaction longue, du code ou l'analyse de documents ?",
    "options": {
        "simple": "question courte, factuelle, de conversation ou de reformulation simple",
        "complexe": "analyse, comparaison, raisonnement en plusieurs étapes, code, calcul ou rédaction longue",
    },
}


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(30)
        self.sock.connect(SOCKET)


def call(method, path, body=None, raw=None):
    connection = UnixConnection("decision")
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    connection.request(method, path, body=data, headers={"Content-Type": "application/json"})
    response = connection.getresponse()
    payload = response.read()
    connection.close()
    return response.status, payload


def check(name, condition):
    print(("ok   " if condition else "ÉCHEC ") + name, flush=True)
    if not condition:
        check.failed = True


check.failed = False


def cases(name):
    """Jeux du routage, lus dans le source TypeScript (une seule source de vérité)."""
    source = open("/cases/routing-cases.ts", encoding="utf-8").read()
    block = source[source.index(f"export const {name}") :]
    block = block[: block.index("];")]
    return [(json.loads(f'"{text}"'), label) for text, label in re.findall(r'\{ text: "((?:[^"\\]|\\.)*)", label: "(simple|complexe)" \}', block)]


def test_cases():
    return cases("ROUTING_TEST")


server = subprocess.Popen([sys.executable, "-I", "/opt/decision/server.py"])
try:
    deadline = time.time() + 180
    while not os.path.exists(SOCKET):
        if time.time() > deadline or server.poll() is not None:
            sys.exit("Le service n'a pas démarré")
        time.sleep(0.5)

    check("identité non-root", os.getuid() != 0)
    check("socket 0660", stat.S_IMODE(os.stat(SOCKET).st_mode) == 0o660)
    try:
        socket.create_connection(("1.1.1.1", 443), timeout=3)
        check("aucun réseau", False)
    except OSError:
        check("aucun réseau", True)

    status, body = call("GET", "/health")
    check("santé", status == 200 and json.loads(body)["status"] == "ok")
    check("route inconnue", call("POST", "/autre", {})[0] == 404)
    check("JSON invalide", call("POST", "/decide", raw=b"{pas du json")[0] == 400)
    check("une seule option", call("POST", "/decide", {"text": "x", "instructions": "Choisir ?", "options": {"a": "b"}})[0] == 400)
    check("clé d'option hostile", call("POST", "/decide", {"text": "x", "instructions": "Choisir ?", "options": {"../a": "b", "c": "d"}})[0] == 400)
    check("texte vide", call("POST", "/decide", {"text": "  ", **QUESTION})[0] == 400)
    check("corps démesuré", call("POST", "/decide", raw=b"x" * (65 * 1024))[0] == 413)

    test = test_cases()
    check("jeu de test lu (24 cas)", len(test) == 24)
    good = 0
    for text, label in test:
        status, body = call("POST", "/decide", {"text": text, **QUESTION})
        decided = "complexe" if json.loads(body)["probabilities"]["complexe"] >= THRESHOLD else "simple"
        good += decided == label
    print(f"Routage (test tenu à l'écart) : {good}/{len(test)}", flush=True)
    # Mesuré à 22/24 ; marge d'un cas pour le bruit numérique entre processeurs.
    check("routage ≥ 21/24", good >= 21)

    # Atelier : tête entraînée sur ROUTING_TRAIN, mesurée une fois sur ROUTING_TEST.
    labels = {"positive": "complexe", "negative": "simple"}
    as_items = lambda items: [{"text": text, "label": label} for text, label in items]
    baseline = {"kind": "zero_shot", "instructions": QUESTION["instructions"], "options": QUESTION["options"], "threshold": THRESHOLD}
    status, body = call("POST", "/train", {"labels": labels, "train": as_items(cases("ROUTING_TRAIN")), "test": as_items(test), "baseline": baseline})
    trained = json.loads(body) if status == 200 else {}
    check("entraînement", status == 200 and len(trained.get("head", {}).get("weights", [])) == 768)
    if trained:
        right = lambda c: c["tp"] + c["tn"]
        print(f"Atelier (test tenu à l'écart) : base {right(trained['baseline'])}/24, tête entraînée {right(trained['candidate'])}/24", flush=True)
        check("référence mesurée comme en production (≥ 21/24)", right(trained["baseline"]) >= 21)
        check("tête entraînée ≥ 22/24", right(trained["candidate"]) >= 22)
        head = trained["head"]
        status, body = call("POST", "/decide", {"text": "Bonjour !", **QUESTION, "head": head})
        check("décision par la tête", status == 200 and json.loads(body).get("head") is True and json.loads(body)["choice"] == "simple")
        check("tête d'une autre révision refusée", call("POST", "/decide", {"text": "x", **QUESTION, "head": {**head, "revision": "autre"}})[0] == 400)
        check("tête mal formée refusée", call("POST", "/decide", {"text": "x", **QUESTION, "head": {**head, "weights": head["weights"][:10]}})[0] == 400)
        check("tête comme référence", call("POST", "/train", {"labels": labels, "train": as_items(cases("ROUTING_TRAIN")), "test": as_items(test), "baseline": {"kind": "head", "head": head}})[0] == 200)
    few = as_items(cases("ROUTING_TRAIN")[:3])
    check("trop peu d'exemples par étiquette", call("POST", "/train", {"labels": labels, "train": few, "test": as_items(test), "baseline": baseline})[0] == 400)
    check("étiquette inconnue", call("POST", "/train", {"labels": labels, "train": [{"text": "x", "label": "autre"}] * 12, "test": as_items(test), "baseline": baseline})[0] == 400)
    # Refus avant lecture : 413, ou connexion coupée pendant l'envoi.
    try:
        refused = call("POST", "/train", raw=b"x" * (5 * 1024 * 1024))[0] == 413
    except OSError:
        refused = True
    check("corps d'entraînement démesuré", refused)
    status, _ = call("GET", "/health")
    check("service toujours disponible", status == 200)
finally:
    server.terminate()
    server.wait(timeout=10)

sys.exit(1 if check.failed else 0)
