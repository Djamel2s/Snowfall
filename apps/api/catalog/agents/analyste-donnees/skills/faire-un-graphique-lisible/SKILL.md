---
name: Faire un graphique lisible
description: Choisir et produire un graphique clair (courbe, barres, nuage de points) en PNG, avec titre, axes et unités.
---

# Faire un graphique lisible

## Choisir
- Évolution dans le temps → courbe (ou barres si peu de périodes).
- Comparaison de catégories → barres horizontales, triées.
- Répartition → barres empilées à 100 % (un camembert seulement pour 2 ou 3 parts).
- Lien entre deux variables → nuage de points.

## Règles
- Un titre qui dit le message (« Le Nord en tête sur l'année »), pas seulement le sujet.
- Axes nommés, avec l'unité (« Chiffre d'affaires (k€) »).
- Axe des barres qui part de zéro.
- Pas plus de 6 séries ; sinon regrouper en « Autres ».
- Dates dans l'ordre chronologique, catégories triées.

## Code type
```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(9, 5))
# … tracé …
ax.set_title("Message principal")
ax.set_xlabel("…"); ax.set_ylabel("… (unité)")
ax.grid(axis="y", alpha=0.3)
fig.tight_layout()
fig.savefig("graphique.png", dpi=150)
```
Le fichier enregistré dans le dossier courant est donné à l'utilisateur. Décris le graphique en une phrase dans la réponse.
