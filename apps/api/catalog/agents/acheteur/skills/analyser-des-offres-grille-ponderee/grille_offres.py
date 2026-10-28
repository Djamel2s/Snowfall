"""Grille d'analyse des offres : notes pondérées, classement, et classeur Excel.

Usage : python grille_offres.py '<json>'
  {
    "criteres": [{"nom": "Prix", "poids": 40}, {"nom": "Qualité technique", "poids": 60}],
    "offres": [{"nom": "Fournisseur A", "notes": {"Prix": 8, "Qualité technique": 6}}, ...],
    "bareme": 10
  }
Les notes vont de 0 au barème (10 par défaut). Les poids sont des pourcentages
dont la somme doit faire 100. Sortie : le classement (texte) et grille_offres.xlsx.
Calcul exact, reproductible : le modèle ne fait pas l'arithmétique de tête.
"""

import json
import sys


def fail(message):
    print(f"ERREUR : {message}")
    sys.exit(1)


def main():
    if len(sys.argv) < 2:
        fail("donner la grille en JSON (voir l'en-tête du script)")
    try:
        data = json.loads(sys.argv[1])
    except ValueError as error:
        fail(f"JSON illisible ({error})")
    criteria = data.get("criteres") or []
    offers = data.get("offres") or []
    scale = float(data.get("bareme", 10))
    if not criteria or not offers:
        fail("il faut au moins un critère et une offre")
    names = [str(item.get("nom", "")).strip() for item in criteria]
    weights = [float(item.get("poids", 0)) for item in criteria]
    if any(not name for name in names) or len(set(names)) != len(names):
        fail("chaque critère a un nom, unique")
    if any(weight < 0 for weight in weights) or abs(sum(weights) - 100) > 0.01:
        fail(f"les poids doivent faire 100 au total (ici {sum(weights):g})")

    rows = []
    for offer in offers:
        label = str(offer.get("nom", "")).strip() or "Sans nom"
        notes = offer.get("notes") or {}
        missing = [name for name in names if name not in notes]
        if missing:
            fail(f"{label} : note manquante pour {', '.join(missing)} (ne pas inventer : demander la note)")
        try:
            values = [float(notes[name]) for name in names]
        except (TypeError, ValueError):
            fail(f"{label} : chaque note doit être un nombre")
        if any(value < 0 or value > scale for value in values):
            fail(f"{label} : chaque note doit être entre 0 et {scale:g}")
        # Note pondérée sur 100 : somme(note / barème × poids).
        total = sum(value / scale * weight for value, weight in zip(values, weights))
        rows.append((label, values, round(total, 2)))

    rows.sort(key=lambda row: row[2], reverse=True)
    print("Classement (note pondérée sur 100) :")
    for rank, (label, values, total) in enumerate(rows, start=1):
        detail = ", ".join(f"{name} {value:g}/{scale:g}" for name, value in zip(names, values))
        print(f"{rank}. {label} : {total:g}/100 ({detail})")
    if len(rows) > 1 and rows[0][2] - rows[1][2] < 5:
        print(f"Attention : écart de {rows[0][2] - rows[1][2]:g} point(s) entre les deux premières offres, sensible aux notes et aux poids.")

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font
    except ImportError:
        print("(classeur non produit : openpyxl indisponible)")
        return
    book = Workbook()
    sheet = book.active
    sheet.title = "Grille"
    sheet.append(["Critère", "Poids (%)"] + [label for label, _, _ in rows])
    for index, name in enumerate(names):
        sheet.append([name, weights[index]] + [values[index] for _, values, _ in rows])
    sheet.append(["Note pondérée /100", 100] + [total for _, _, total in rows])
    for cell in sheet[1]:
        cell.font = Font(bold=True)
    for cell in sheet[sheet.max_row]:
        cell.font = Font(bold=True)
    sheet.column_dimensions["A"].width = 28
    book.save("grille_offres.xlsx")
    print("Classeur produit : grille_offres.xlsx")


if __name__ == "__main__":
    main()
