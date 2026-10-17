# Fiche 12 — Branches de conversation : un arbre plutôt qu'une liste

> Phase 3, étape 1. Modifier une question ne doit plus effacer la suite.

## 1. Le modèle de données

Avant, une conversation était une **liste** : modifier le 3ᵉ message supprimait
le 3ᵉ et tout ce qui suivait. Maintenant, c'est un **arbre** :

```
Q1 → R1 → Q2  → R2        ← version 1/2
          ↘ Q2' → R2'      ← version 2/2 (Q2 modifiée)
                ↘ R2''     ← R2' régénérée
```

- Chaque message a un **parent** : le précédent dans sa branche.
- Modifier Q2 crée **Q2', sœur** de Q2 (même parent : R1).
- Régénérer R2' crée **R2'', sœur** de R2'.
- La conversation retient la **feuille affichée**. Le chemin de la racine à
  cette feuille est l'historique, à l'écran comme pour le modèle.
- Choisir une version d'un message affiche **sa suite la plus récente**.

Toute la logique est une fonction pure (`conversations/branches.ts`), testée seule
et partagée par le vrai magasin (PostgreSQL) et celui des tests.

## 2. Ce qu'il fallait protéger

| Risque | Mesure |
|---|---|
| Un message rattaché à la conversation d'un autre | Clé étrangère composite : un parent est toujours de la **même** conversation |
| Changer de branche pendant une réponse | Refusé (409) tant qu'une réponse est en cours |
| Données plus lourdes à déchiffrer | Seule la branche affichée est déchiffrée ; les autres versions ne le sont qu'à la demande |
| Conversations existantes | Migration de reprise : les anciens messages sont chaînés dans l'ordre |

**Piège rencontré :** la RLS est *imposée* (`FORCE`), y compris au propriétaire
du schéma. La migration de reprise ne voyait donc aucune ligne. Elle suspend la
contrainte **dans sa propre transaction**, puis la rétablit. On l'a vérifié en
simulant d'anciennes conversations.

## 3. Le catalogue d'agents

La section Agents devient une grille de cartes : avatar, nom, modèle, outils en
icônes ; recherche, filtre « les miens », duplication. Dupliquer copie le profil
et les outils, **pas** la base de connaissances : ses documents restent ceux de
l'agent d'origine, sous le contrôle de son auteur.

## Pour vérifier que tu as compris

1. Pourquoi une sœur, et pas un enfant, quand on modifie un message ?
2. Pourquoi la clé étrangère porte-t-elle sur (parent, conversation) et pas seulement sur le parent ?
3. Que se passerait-il si la migration de reprise ne suspendait pas la RLS imposée ?
