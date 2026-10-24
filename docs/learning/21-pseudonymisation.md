# Fiche 21 — Pseudonymiser avant d'envoyer, restituer au retour

> Un modèle externe doit lire le texte pour répondre. Mais il n'a pas besoin de
> savoir que « Julie Martin » s'appelle Julie Martin : « [PERSONNE_1] » lui
> suffit pour écrire la bonne réponse. On remplace avant l'envoi, on remet au retour.

## 1. Anonymiser ou pseudonymiser ?

| | Anonymisation | Pseudonymisation |
|---|---|---|
| Réversible ? | non | oui (avec la table de correspondance) |
| Encore une donnée personnelle (RGPD) ? | non | **oui** |
| Faisable sur du texte libre ? | presque jamais garanti | oui, en partie |

Ici, c'est de la pseudonymisation : le fournisseur ne voit plus qui est concerné,
mais la plateforme, elle, sait toujours. La table de correspondance ne quitte
jamais le serveur.

## 2. Le circuit

```
« Préviens Julie Martin (julie.martin@polaris.fr) »
        │ masquage (sur la plateforme)
        ▼
« Préviens [PERSONNE_1] ([EMAIL_1]) »  ──►  fournisseur externe
                                                │
« C'est noté, [PERSONNE_1] sera prévenue. »  ◄──┘
        │ restitution (au fil du flux)
        ▼
« C'est noté, Julie Martin sera prévenue. »
```

Quatre détails qui comptent :

1. **Jetons stables** : la même personne reçoit le même jeton partout (instructions,
   historique, résultats d'outils). « Martin » seul, après « Julie Martin », reste
   [PERSONNE_1]. Sinon le modèle croit parler de deux personnes.
2. **Flux** : la réponse arrive par morceaux. Si un morceau se termine par
   « [PERS », on attend la suite avant d'afficher, pour restituer le jeton entier.
3. **Outils** : quand le modèle demande « cherche [PERSONNE_1] dans la base », on
   remet le vrai nom AVANT d'exécuter, car la base locale contient les vrais noms.
4. **Ce qu'on ne touche pas** : les blocs signés par le fournisseur (réflexion
   d'Anthropic). Les modifier ferait rejeter la requête suivante.

## 3. Stocker la correspondance ? Non, la reconstruire

Garder la table rendrait vulnérable une donnée de plus. Or l'historique ne fait
que s'allonger, et les jetons sont numérotés par ordre d'apparition. À l'appel
suivant, on refait donc le masquage depuis les vrais textes et on retombe sur
les mêmes numéros. Rien à conserver, rien à protéger.

## 4. Les attaques auxquelles penser

- **Faux jeton** : un document collé contient « [PERSONNE_1] ». Sans précaution,
  la restitution le transformerait en Julie Martin. On neutralise donc les jetons
  déjà présents à l'entrée.
- **Texte piégé** : un texte de 260 Ko conçu pour faire ramer l'analyse. Notre
  premier contrôle de chevauchement était quadratique (plus de 4 s) ; avec une
  carte d'occupation des caractères, on passe à 37 ms.

## 5. Mesurer, et dire ce qui manque

Sur un jeu tenu à l'écart : **14 valeurs personnelles sur 15 masquées, aucun mot
ordinaire abîmé** (Orion, Atlas, Paris, Renault sont restés intacts). La fuite :
« Moreau » seul, sans civilité ni prénom. Aucune règle ne sait qu'il s'agit d'une
personne, il faudrait un modèle local de reconnaissance d'entités.

Ce qui n'est pas encore mesuré : **l'effet sur la qualité des réponses** avec un
vrai modèle. L'option est donc désactivée par défaut, et le banc d'évaluation
sait comparer avec et sans (`--pseudonymize`).

## À retenir

1. Pseudonymiser n'est pas anonymiser : la donnée reste personnelle, mais le
   fournisseur ne sait plus qui.
2. Des jetons stables, restitués au fil du flux et avant chaque outil.
3. Ne rien stocker : reconstruire la correspondance à l'identique.
4. Neutraliser les faux jetons, borner le temps d'analyse.
5. Activer par défaut seulement après avoir mesuré la qualité.
