"""Télécharge le modèle Laya à une révision figée et vérifie ses empreintes (au build seulement)."""

import hashlib
import os
import sys

from huggingface_hub import snapshot_download

REPO = os.environ["LAYA_REPO"]
REVISION = os.environ["LAYA_REVISION"]
SUBFOLDER = os.environ["LAYA_SUBFOLDER"]

# Empreintes SHA-256 publiées par le Hub pour cette révision (fichiers LFS).
EXPECTED = {
    f"{SUBFOLDER}/model.safetensors": "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204",
    f"{SUBFOLDER}/tokenizer/tokenizer.json": "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
}

path = snapshot_download(REPO, revision=REVISION, allow_patterns=[f"{SUBFOLDER}/*", f"{SUBFOLDER}/**/*"])

for name, expected in EXPECTED.items():
    digest = hashlib.sha256()
    with open(os.path.join(path, name), "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    if digest.hexdigest() != expected:
        print(f"Empreinte inattendue pour {name} : build refusé.", file=sys.stderr)
        sys.exit(1)
    print(f"ok {name}")
# Aucun fichier pickle ni code distant : seulement des poids safetensors et des JSON.
for root, _dirs, files in os.walk(path):
    for file in files:
        if file.endswith((".bin", ".pkl", ".pt", ".py")):
            print(f"Fichier non attendu : {file}", file=sys.stderr)
            sys.exit(1)
print(path)
