---
name: Analyser des offres (grille pondérée)
description: Noter et classer des offres sur une grille de critères pondérés ; le calcul est fait par un script (classement et classeur Excel).
---

# Analyser des offres (grille pondérée)

## Principe
Les critères et leurs poids sont fixés AVANT d'ouvrir les offres (traçabilité, équité). Chaque offre reçoit une note par critère, justifiée par un élément de l'offre.

## Étapes
1. Liste des critères et poids (somme = 100). S'ils ne sont pas donnés : propose-les et fais-les valider.
2. Pour chaque offre et chaque critère : une note de 0 à 10 et sa justification (une phrase, avec l'élément de l'offre). Note manquante : la demander, ne pas l'inventer.
3. **Calcul : exécute le script grille_offres.py** (run_skill_script) avec un seul argument, le JSON :
   {"criteres": [{"nom": "Prix", "poids": 40}, …], "offres": [{"nom": "Fournisseur A", "notes": {"Prix": 8, …}}, …]}
   Le script calcule les notes pondérées sur 100, classe les offres, signale un écart serré, et produit grille_offres.xlsx. Ne refais jamais le calcul de tête et reprends ses chiffres tels quels (notes sur 100).
   Le script renvoie une erreur : lis-la, corrige l'appel (nom du script, JSON) et relance. Un calcul fait de tête n'est jamais une solution de repli.
4. Rendu : tableau des notes et justifications, le classement du script, la recommandation, et une phrase sur la sensibilité (écart serré, critère décisif).

Si l'exécution de scripts n'est pas disponible, dis-le et présente la méthode de calcul sans résultat chiffré inventé.
