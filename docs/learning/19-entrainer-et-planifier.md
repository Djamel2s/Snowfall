# Fiche 19 — Entraîner un petit décideur, faire travailler un agent seul

> Phase 5, étapes 6 et 7. Entraîner un modèle n'est pas réservé aux GPU : une
> « tête » de quelques milliers de nombres suffit pour une décision précise. Et
> un agent qui travaille la nuit doit rester aussi encadré qu'en plein jour.

## 1. Embeddings + tête : le transfert d'apprentissage le plus simple

Laya transforme un texte en un vecteur de 768 nombres (un **embedding**) qui
résume son sens. Ces vecteurs sont déjà riches : des questions « complexes »
tombent dans une même région de l'espace. Il suffit alors d'apprendre une
**frontière** : une régression logistique, soit 768 poids et un biais.

```
texte ──► Laya (figé, jamais modifié) ──► vecteur 768 ──► tête apprise ──► P(complexe)
```

- Rien de Laya n'est réentraîné : on ne peut pas l'abîmer.
- Quelques dizaines d'exemples et quelques secondes de processeur suffisent.
- La tête dépend de la **révision exacte** du modèle : un autre Laya produit
  d'autres vecteurs, d'où le refus d'une tête entraînée sur une autre révision.

Pourquoi pas un LoRA (réglage fin d'un grand modèle) ? Il faut un GPU, des
milliers d'exemples, et un banc pour prouver le gain. Sans ces trois éléments, ce
serait une promesse, pas une mesure.

## 2. Trois parts, trois usages

| Part | Sert à | Jamais à |
|---|---|---|
| Entraînement | apprendre les poids | mesurer |
| Validation croisée (dans l'entraînement) | choisir la régularisation et le seuil | — |
| Test (fixé à l'ajout, ≈ 30 %) | une seule mesure, pour décider | régler quoi que ce soit |

La part de test est tirée **une fois** pour chaque exemple, au moment de son
ajout, et ne peut plus changer. Sinon on finirait par mettre les « faciles » en
test. Limite à connaître : réentraîner dix fois sur le même test revient à
choisir le modèle qui a eu de la chance sur ce test. D'où la règle : ajouter
régulièrement des exemples neufs.

Résultat sur notre banc : 22/24 → **24/24** pour le routage. C'est vrai, mais
c'est 2 cas : on l'annonce comme tel, sans en faire un argument commercial.

## 3. Déployer seulement ce qui bat la référence

La référence, c'est **le décideur en place** : la tête active, ou Laya de base.
On les mesure tous les deux, sur la même part de test, au même moment. Un modèle
est déployable s'il fait **plus de bonnes décisions** ET **ne reconnaît pas moins
de questions complexes**. Rater une question complexe donne une mauvaise réponse,
alors qu'en surestimer une coûte seulement un peu plus cher : l'asymétrie guide
la règle. Elle est vérifiée trois fois : à l'entraînement, à l'activation, et
par une contrainte en base.

## 4. Un agent planifié : même chemin, mêmes garde-fous

La tentation est d'écrire un second chemin « spécial tâches de fond ». Le
risque : il oublie un jour un contrôle (quota, règle de deux, audit). Ici, la
tâche planifiée **envoie un vrai message** par la route existante, en interne,
au nom de son auteur. Tous les contrôles s'appliquent, par construction.

Pour s'identifier sans session, le planificateur crée un **jeton aléatoire
de 256 bits, à usage unique, valable 30 secondes**, gardé en mémoire pour cette
seule requête. Depuis le réseau, l'en-tête est effacé par nginx, et un jeton
deviné n'existe pas.

Et personne ne valide à la place de l'auteur : une écriture demandée la nuit
attend dans la conversation, puis expire en refus.

## 5. Plusieurs instances, une seule exécution

Deux serveurs qui voient la même tâche due ne doivent pas la lancer deux fois.
La solution classique : prendre la tâche **à bail** dans une transaction
(`FOR UPDATE SKIP LOCKED`), avec une échéance. Le premier la prend, le second
passe son tour. Détail qui compte : modifier la tâche pendant son exécution ne
doit pas rendre le bail, sinon une autre instance la relancerait.

Autre piège rencontré : la RLS imposée vaut aussi pour le propriétaire de la
table. Une fonction « système » ne voyait donc rien. La réponse est une **file
sans contenu** (identifiants et échéances), tenue à jour par un déclencheur
SQL, accessible seulement par la fonction de prise en charge.

## 6. Le temps est un piège

« Chaque lundi à 9 h » est une heure **locale**. En France, le dernier dimanche
d'octobre, 9 h passe de 07:00 à 08:00 UTC. Et le dernier dimanche de mars, 2 h
du matin n'existe pas. Le test l'a montré : on tombait une heure trop tôt. On
calcule donc dans le fuseau de l'auteur, avec des tests sur ces deux dates.

## À retenir

1. Embeddings figés + petite tête : apprendre vite, sans risque pour le modèle.
2. Le test est fixé à l'ajout et sert une seule fois par décision.
3. On compare toujours au décideur en place, sur les mêmes données.
4. Une tâche de fond passe par le chemin normal, pas par un raccourci.
5. Prise à bail atomique : une tâche, une exécution.
6. Fuseau et changements d'heure : toujours testés.
