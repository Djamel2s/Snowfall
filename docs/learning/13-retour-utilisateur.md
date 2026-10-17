# Fiche 13 — Le retour des utilisateurs : boucler avec les évaluations

> Phase 3, étape 2. Le banc d'évaluation (fiche 10) mesure ce qu'on a prévu.
> Le 👎 d'un utilisateur montre ce qu'on n'avait **pas** prévu.

## 1. La boucle

```
réponse ──► 👎 (+ « c'est 40 € à l'étranger »)
   │            │
   │            ├─► Snowfall : note + commentaire chiffré (l'utilisateur le retrouve)
   │            └─► Langfuse : la NOTE seule, sur la trace de cette réponse
   ▼
l'équipe filtre les traces notées 👎 → comprend (outil mal choisi ? source ratée ?)
   ▼
un nouveau cas dans agent-cases.ts → le défaut ne reviendra pas sans qu'on le voie
```

## 2. Relier une note à la bonne trace

La trace d'une réponse est créée **avant** que la réponse n'existe ; le message
enregistré à la fin ne connaît pas l'identifiant de trace. Solution :
l'identifiant de trace est **calculé à partir du run** (`sha256(run)`), et chaque
réponse retient son run. Bonus : une réponse reprise après une validation garde
la même trace.

## 3. Ce qui sort, et ce qui ne sort pas

| Donnée | Base Snowfall | Audit | Langfuse |
|---|---|---|---|
| Note 👍/👎 | oui | oui | oui |
| Commentaire | chiffré | « présent : oui/non » | **jamais** |

Le commentaire peut contenir des données personnelles (« voir le dossier de
M. Martin ») : il reste chez nous, chiffré, comme la conversation.

**Retiens :** un signal utile n'a pas besoin du contenu. La note suffit à trouver
la trace ; la trace (masquée) suffit souvent à comprendre.

## Pour vérifier que tu as compris

1. Pourquoi ne pas envoyer le commentaire à Langfuse, alors que les traces sont auto-hébergées ?
2. Pourquoi l'identifiant de score est-il fixe (`feedback-<message>`) ?
3. Comment un 👎 devient-il un cas d'évaluation, sans copier la conversation de l'utilisateur ?
