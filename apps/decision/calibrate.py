"""Choisit le seuil du routage sur ROUTING_TRAIN seulement, puis le mesure une fois sur ROUTING_TEST.

À relancer quand la révision du modèle ou la formulation de la question change :

  docker run --rm --network none --entrypoint python3 \
    -v "$PWD/apps/decision:/t:ro" -v "$PWD/apps/api/src/decision:/cases:ro" \
    snowfall-decision -I /t/calibrate.py

Reporter ensuite le seuil dans routing.ts (ROUTING_COMPLEX_THRESHOLD) et
decision_test.py (THRESHOLD). Ne jamais ajuster le seuil en regardant le test.
"""

import json
import os
import re

import laya

QUESTION = {
    "instructions": "Cette demande exige-t-elle un raisonnement approfondi, une rédaction longue, du code ou l'analyse de documents ?",
    "criteria": {
        "simple": "question courte, factuelle, de conversation ou de reformulation simple",
        "complexe": "analyse, comparaison, raisonnement en plusieurs étapes, code, calcul ou rédaction longue",
    },
}


def cases(name):
    source = open("/cases/routing-cases.ts", encoding="utf-8").read()
    block = source[source.index(f"export const {name}") :]
    block = block[: block.index("];")]
    return [(json.loads(f'"{text}"'), label) for text, label in re.findall(r'\{ text: "((?:[^"\\]|\\.)*)", label: "(simple|complexe)" \}', block)]


agent = laya.load(os.environ["LAYA_REPO"], subfolder=os.environ["LAYA_SUBFOLDER"], revision=os.environ["LAYA_REVISION"], device="cpu")


def scored(items):
    return [(agent.predict(text, {"q": {"type": "choice", **QUESTION}})["answers"]["q"]["probabilities"]["complexe"], label) for text, label in items]


def accuracy(items, threshold):
    """Exactitude équilibrée : chaque classe compte autant."""
    pos = [p for p, label in items if label == "complexe"]
    neg = [p for p, label in items if label == "simple"]
    return (sum(p >= threshold for p in pos) / len(pos) + sum(p < threshold for p in neg) / len(neg)) / 2


train = scored(cases("ROUTING_TRAIN"))
threshold = max((accuracy(train, step / 100), step / 100) for step in range(1, 100))[1]
print(f"Seuil choisi sur l'entraînement ({len(train)} cas) : P(complexe) >= {threshold:.2f}")

test = scored(cases("ROUTING_TEST"))
good = sum((p >= threshold) == (label == "complexe") for p, label in test)
missed = sum(p < threshold for p, label in test if label == "complexe")
wrong = sum(p >= threshold for p, label in test if label == "simple")
print(f"Test tenu à l'écart ({len(test)} cas) : {good}/{len(test)} ; complexes jugées simples : {missed} ; simples envoyées au puissant : {wrong}")
