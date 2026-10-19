"""Service de décision local pour Snowfall (Laya, modèle de décision typée).

Rôle : prendre très vite de petites décisions (ex. « cette question est-elle
simple ou complexe ? » pour le routage des modèles), sans rien envoyer hors de la
plateforme. Le conteneur n'a AUCUN réseau : l'API lui parle par un socket Unix
réservé à son groupe. Le modèle a été téléchargé et vérifié au build (révision
figée, empreintes SHA-256) ; il est chargé une fois, en lecture seule.

Contrats :
- POST /decide {"text", "instructions", "options": {clé: description}, "head"?}
  → {"choice", "probabilities", "confidence"}. Avec "head" (tête entraînée par
  l'atelier), la décision vient de la tête appliquée aux embeddings de Laya.
- POST /train {"labels": {"positive", "negative"}, "train": [{text, label}],
  "test": [{text, label}], "baseline": {...}} → {"head", "candidate", "baseline", "cv"}.
  Entraîne une régression logistique sur les embeddings (réglages choisis par
  validation croisée sur l'entraînement SEULEMENT), puis mesure une fois la
  tête et la référence sur le test. Rien n'est gardé ici : l'API stocke la tête.
Bornes : texte 4 000 caractères, 2 à 20 options, 500 exemples d'entraînement et
200 de test, une inférence à la fois.
"""

import grp
import json
import math
import os
import re
import socketserver
import threading
from http.server import BaseHTTPRequestHandler

import laya
import numpy as np

SOCKET_PATH = os.environ.get("DECISION_SOCKET", "/run/decision/decision.sock")
SOCKET_GROUP = os.environ.get("DECISION_SOCKET_GROUP", "decisionapi")
REVISION = os.environ["LAYA_REVISION"][:12]
MAX_DECIDE_BODY = 64 * 1024
MAX_TRAIN_BODY = 4 * 1024 * 1024
MAX_TEXT = 4_000
MAX_TRAIN, MAX_TEST, MIN_PER_LABEL = 500, 200, 5
DIM = 768
KEY = re.compile(r"^[a-z0-9_-]{1,40}$")

agent = laya.load(os.environ["LAYA_REPO"], subfolder=os.environ["LAYA_SUBFOLDER"], revision=os.environ["LAYA_REVISION"], device="cpu")
embed_fn = laya.embed_fn_from_agent(agent)
# Une inférence à la fois (modèle partagé) ; au-delà de 8 en attente : refus immédiat.
LOCK = threading.Lock()
WAITING = threading.BoundedSemaphore(8)
# Un entraînement à la fois ; il rend le verrou entre deux lots (le routage continue).
TRAINING = threading.Lock()


def embed(texts):
    vectors = []
    for start in range(0, len(texts), 16):
        with LOCK:
            vectors.append(np.asarray(embed_fn([text[:MAX_TEXT] for text in texts[start : start + 16]]), dtype=np.float64))
    return np.vstack(vectors) if vectors else np.zeros((0, DIM))


def valid_options(instructions, options):
    if not isinstance(instructions, str) or not 3 <= len(instructions) <= 500:
        return False
    if not isinstance(options, dict) or not 2 <= len(options) <= 20:
        return False
    return all(isinstance(key, str) and KEY.match(key) and isinstance(value, str) and 1 <= len(value) <= 300 for key, value in options.items())


def valid_head(head):
    """Tête de l'atelier : poids finis, bonne dimension, entraînée sur CETTE révision du modèle."""
    if not isinstance(head, dict) or head.get("revision") != REVISION:
        return False
    weights, bias, threshold, labels = head.get("weights"), head.get("bias"), head.get("threshold"), head.get("labels")
    if not isinstance(weights, list) or len(weights) != DIM or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in weights):
        return False
    if not isinstance(bias, (int, float)) or not math.isfinite(bias) or not isinstance(threshold, (int, float)) or not 0 < threshold < 1:
        return False
    return isinstance(labels, dict) and all(isinstance(labels.get(k), str) and KEY.match(labels[k]) for k in ("positive", "negative"))


def apply_head(head, vectors):
    z = vectors @ np.asarray(head["weights"], dtype=np.float64) + float(head["bias"])
    return 1 / (1 + np.exp(-np.clip(z, -50, 50)))


def fit(x, y, l2, steps=2000):
    """Régression logistique (descente de gradient), standardisation repliée dans les poids."""
    mean, std = x.mean(0), x.std(0) + 1e-6
    z = (x - mean) / std
    w, b = np.zeros(z.shape[1]), 0.0
    for _ in range(steps):
        p = 1 / (1 + np.exp(-np.clip(z @ w + b, -50, 50)))
        w -= 0.05 * (z.T @ (p - y) / len(y) + l2 * w)
        b -= 0.05 * float(np.mean(p - y))
    return w / std, b - float(np.sum(w * mean / std))


def choose(x, y, folds=5):
    """L2 et seuil par validation croisée sur l'entraînement : exactitude équilibrée."""
    order = np.random.default_rng(0).permutation(len(y))
    best = None
    for l2 in (0.01, 0.1, 1.0):
        scores = np.zeros(len(y))
        for k in range(folds):
            held = order[k::folds]
            kept = np.setdiff1d(order, held)
            w, b = fit(x[kept], y[kept], l2, steps=1000)
            scores[held] = 1 / (1 + np.exp(-np.clip(x[held] @ w + b, -50, 50)))
        for t in np.arange(0.2, 0.81, 0.05):
            accuracy = (np.mean(scores[y == 1] >= t) + np.mean(scores[y == 0] < t)) / 2
            candidate = (float(accuracy), -abs(float(t) - 0.5), l2, round(float(t), 2))
            best = candidate if best is None or candidate > best else best
    return best[2], best[3], best[0]


def confusion(decided, y):
    return {"tp": int(np.sum(decided & (y == 1))), "fn": int(np.sum(~decided & (y == 1))), "tn": int(np.sum(~decided & (y == 0))), "fp": int(np.sum(decided & (y == 0)))}


def parse_examples(items, labels, limit):
    if not isinstance(items, list) or not 1 <= len(items) <= limit:
        return None
    texts, y = [], []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip() or item.get("label") not in (labels["positive"], labels["negative"]):
            return None
        texts.append(item["text"][:MAX_TEXT])
        y.append(1.0 if item["label"] == labels["positive"] else 0.0)
    y = np.asarray(y)
    return (texts, y) if min(int(np.sum(y == 1)), int(np.sum(y == 0))) >= MIN_PER_LABEL else None


def train(body):
    labels = body.get("labels")
    if not isinstance(labels, dict) or not all(isinstance(labels.get(k), str) and KEY.match(labels[k]) for k in ("positive", "negative")) or labels["positive"] == labels["negative"]:
        return None
    train_set, test_set = parse_examples(body.get("train"), labels, MAX_TRAIN), parse_examples(body.get("test"), labels, MAX_TEST)
    baseline = body.get("baseline")
    if not train_set or not test_set or not isinstance(baseline, dict):
        return None
    if baseline.get("kind") == "head":
        if not valid_head(baseline.get("head")):
            return None
    elif baseline.get("kind") == "zero_shot":
        threshold = baseline.get("threshold")
        if not valid_options(baseline.get("instructions"), baseline.get("options")) or labels["positive"] not in baseline["options"] or not isinstance(threshold, (int, float)) or not 0 < threshold < 1:
            return None
    else:
        return None

    x_train, x_test = embed(train_set[0]), embed(test_set[0])
    l2, threshold, cv = choose(x_train, train_set[1])
    weights, bias = fit(x_train, train_set[1], l2)
    head = {"revision": REVISION, "weights": [round(float(v), 7) for v in weights], "bias": round(float(bias), 7), "threshold": threshold, "labels": {"positive": labels["positive"], "negative": labels["negative"]}}
    candidate = confusion(apply_head(head, x_test) >= threshold, test_set[1])
    if baseline["kind"] == "head":
        reference = confusion(apply_head(baseline["head"], x_test) >= baseline["head"]["threshold"], test_set[1])
    else:
        question = {"q": {"type": "choice", "instructions": baseline["instructions"], "criteria": baseline["options"]}}
        scores = []
        for text in test_set[0]:
            with LOCK:
                scores.append(agent.predict(text, question)["answers"]["q"]["probabilities"][labels["positive"]])
        reference = confusion(np.asarray(scores) >= baseline["threshold"], test_set[1])
    return {"head": head, "candidate": candidate, "baseline": reference, "cv": round(cv, 3), "l2": l2}


class Handler(BaseHTTPRequestHandler):
    server_version = "snowfall-decision"
    sys_version = ""

    def reply(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"status": "ok", "revision": REVISION})
        return self.reply(404, {"error": "not_found"})

    def read_json(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None, 400
        if length <= 0 or length > limit:
            return None, 413
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return None, 400
        return (body, 200) if isinstance(body, dict) else (None, 400)

    def do_POST(self):
        if self.path == "/decide":
            return self.decide()
        if self.path == "/train":
            return self.train()
        return self.reply(404, {"error": "not_found"})

    def decide(self):
        body, status = self.read_json(MAX_DECIDE_BODY)
        if body is None:
            return self.reply(status, {"error": "too_large" if status == 413 else "invalid_request"})
        text, head = body.get("text"), body.get("head")
        if not isinstance(text, str) or not text.strip() or not valid_options(body.get("instructions"), body.get("options")) or (head is not None and not valid_head(head)):
            return self.reply(400, {"error": "invalid_request"})
        if not WAITING.acquire(blocking=False):
            return self.reply(429, {"error": "busy"})
        try:
            if head is not None:
                with LOCK:
                    vector = np.asarray(embed_fn([text[:MAX_TEXT]]), dtype=np.float64)
                p = float(apply_head(head, vector)[0])
                positive, negative = head["labels"]["positive"], head["labels"]["negative"]
                choice = positive if p >= head["threshold"] else negative
                return self.reply(200, {"choice": choice, "probabilities": {positive: p, negative: 1 - p}, "confidence": max(p, 1 - p), "head": True})
            with LOCK:
                answer = agent.predict(text[:MAX_TEXT], {"q": {"type": "choice", "instructions": body["instructions"], "criteria": body["options"]}})["answers"]["q"]
            return self.reply(200, {"choice": answer["choice"], "probabilities": answer["probabilities"], "confidence": answer["confidence"]})
        except Exception as error:  # noqa: BLE001 - le détail reste dans le journal du conteneur
            print(f"Échec de décision : {type(error).__name__}", flush=True)
            return self.reply(500, {"error": "internal"})
        finally:
            WAITING.release()

    def train(self):
        body, status = self.read_json(MAX_TRAIN_BODY)
        if body is None:
            return self.reply(status, {"error": "too_large" if status == 413 else "invalid_request"})
        if not TRAINING.acquire(blocking=False):
            return self.reply(429, {"error": "busy"})
        try:
            result = train(body)
            return self.reply(200, result) if result else self.reply(400, {"error": "invalid_request"})
        except Exception as error:  # noqa: BLE001
            print(f"Échec d'entraînement : {type(error).__name__}", flush=True)
            return self.reply(500, {"error": "internal"})
        finally:
            TRAINING.release()

    def log_message(self, format, *args):
        # Journal minimal : jamais le texte évalué.
        print(f"{self.command} {self.path} {args[1] if len(args) > 1 else ''}", flush=True)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(os.path.dirname(SOCKET_PATH), exist_ok=True)
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)
    server = Server(SOCKET_PATH, Handler)
    os.chmod(SOCKET_PATH, 0o660)
    try:
        os.chown(SOCKET_PATH, -1, grp.getgrnam(SOCKET_GROUP).gr_gid)
    except (KeyError, PermissionError):
        pass
    print(f"Décision prête sur {SOCKET_PATH}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
