---
name: Explorer un jeu de données
description: Premier examen d'un fichier de données avant toute analyse : dimensions, types, valeurs manquantes, doublons, incohérences.
---

# Explorer un jeu de données

À faire AVANT toute analyse, en une exécution (adapter le nom du fichier) :

```python
import pandas as pd
df = pd.read_csv("inputs/FICHIER.csv", sep=None, engine="python")  # ou pd.read_excel("inputs/FICHIER.xlsx")
print(df.shape)
print(df.dtypes)
print(df.head(5).to_string())
print("Valeurs manquantes :", df.isna().sum().to_dict())
print("Doublons (lignes identiques) :", int(df.duplicated().sum()))
print(df.describe(include="all").T.to_string())
```

## À vérifier et à signaler (avec le nombre)
- **Manquants** : cellules vides, mais aussi « N/A », « - », « ? », « inconnu » (à convertir : `pd.to_numeric(..., errors="coerce")`).
- **Doublons** : lignes identiques ; ou même identifiant sur deux lignes.
- **Types** : nombres lus comme texte (espaces, « € », virgule décimale → `decimal=","` et `thousands=" "`), dates en texte (`pd.to_datetime(..., dayfirst=True)`).
- **Incohérences** : montants négatifs, dates futures ou impossibles, catégories écrites de deux façons (« Nord » / « nord »), totaux déjà présents dans le fichier (ligne « Total » à exclure).
- **Valeurs extrêmes** : au-delà de 1,5 × l'écart interquartile, à examiner (erreur ou vrai cas ?).

## Rendu
« Le fichier contient N lignes et M colonnes (…). Qualité : X doublons, Y valeurs manquantes dans « colonne », Z montants négatifs. Traitement : … »
Ne supprime ni ne corrige rien sans le dire.
