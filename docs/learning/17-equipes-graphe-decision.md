# Fiche 17 — Équipes d'agents, carte animée, décider vite et localement

> Phase 5, étapes 1 à 4. Des agents qui délèguent à d'autres agents, une carte
> pour les voir travailler, et un petit modèle qui prend en 85 ms une décision
> qu'on confiait jusque-là au hasard (ou au modèle le plus cher). Et une mesure
> qui nous dit **non**.

## 1. Déléguer, sans donner plus de droits

Un agent « Juriste » peut confier une tâche à « Support RH », qui peut lui-même
la confier à « Archiviste ». Trois règles font que c'est sûr :

```
utilisateur (ses droits)
   └─ Juriste : outils A ∩ droits de l'utilisateur
        └─ Support RH : ses outils ∩ ceux du Juriste      ← intersection
             └─ Archiviste : ∩ encore, et plus de délégation (profondeur 2)
```

- **Intersection** : un sous-agent n'a jamais un outil que l'appelant n'a pas.
  Sinon, déléguer serait une façon de contourner un refus (escalade de privilèges).
- **Les validations remontent** : quand l'Archiviste veut écrire, c'est
  l'utilisateur qui valide, avec la ligne « pour le compte de Support RH ».
  Personne ne valide à la place de l'humain.
- **Un budget pour toute l'équipe** : les tokens de la réponse sont partagés ;
  sinon, chaque niveau multiplierait le coût (et l'abus).

Le piège technique : LangGraph garde son contexte (qui écrit le flux, qui gère
les pauses) dans une variable « invisible » qui suit les appels asynchrones. Un
sous-agent lancé depuis un outil en héritait : ses tokens apparaissaient dans la
réponse du parent. La fonction `isolated()` lance le sous-agent **hors** de ce
contexte. Retenir : un framework qui « porte » un état implicite doit être isolé
dès qu'on l'imbrique.

Autre détail qui compte : chaque sous-agent a son propre fil de reprise
(`runId~clé`). Si la réponse est reprise après une validation, on ne rejoue pas
l'écriture déjà approuvée — le fil n'est effacé qu'avec le run parent.

## 2. La carte : une simulation de forces

La carte ne place pas les nœuds à la main : elle simule des **forces** (d3-force).
Les nœuds se repoussent comme des charges, les liens tirent comme des ressorts,
une force douce ramène tout vers le centre. À chaque « tic », on redessine.

Deux leçons venues des tests :
- **Accessibilité** : un SVG marqué « image » cache tout à un lecteur d'écran et
  au clavier. Chaque agent est maintenant un bouton (Tab, puis Entrée).
- **Mobile** : la répulsion était réglée pour un grand écran ; sur 390 px, un
  agent pouvait naître hors de l'écran. Le test le tapait « parfois » — un test
  instable signale souvent un vrai défaut. Correctif : cadrage automatique tant
  que l'utilisateur n'a pas zoomé ni déplacé la vue.

## 3. Un modèle de décision : choisir, pas écrire

Un LLM génère du texte. Un **modèle de décision** (ici Laya, Apache 2.0) reçoit
un texte et une question à options, et rend une **probabilité par option** :

```
« Et pour demain ? »  +  simple / complexe ?
        → { simple: 0.31, complexe: 0.69 }      (valeurs d'exemple ; ~85 ms sur le processeur)
```

Usage : le **routage des modèles**. Une question simple part vers un modèle rapide
et bon marché, une question complexe vers le puissant. Gain : coût et latence,
sans toucher à la qualité des questions difficiles.

### Le seuil : choisi sur l'entraînement, mesuré une fois

Le choix brut du modèle (l'option la plus probable) donnait 17/24. Mais on peut
choisir **où couper** : « complexe si P(complexe) ≥ t ». La méthode honnête :

1. choisir `t` sur le jeu d'**entraînement** seulement (30 cas) → `t = 0,83` ;
2. mesurer **une seule fois** sur le jeu de **test** tenu à l'écart (24 cas) →
   **22/24**, aucune question simple mal envoyée, 2 complexes manquées.

Si l'on réglait `t` en regardant le test, on mesurerait notre talent à
surapprendre, pas le modèle. Même raison pour laquelle l'heuristique (mots-clés)
affiche 24/24 sur ce test : je l'ai écrite en le connaissant — chiffre **biaisé**,
donc non publié comme mesure.

### Prudence par construction

```
heuristique dit « complexe » ?  → puissant (sans même appeler le modèle)
sinon modèle : P(complexe) ≥ 0,83 ? → puissant, sinon rapide
modèle absent, lent (3 s) ou en panne → heuristique seule
```

Se tromper vers le modèle puissant coûte un peu d'argent ; se tromper vers le
rapide coûte une mauvaise réponse. L'asymétrie guide la règle.

### Le déployer comme un composant non fiable

- Modèle téléchargé **au build**, révision figée, empreintes SHA-256 vérifiées,
  formats exécutables (`.bin`, `.pkl`) refusés : un fichier de poids PyTorch
  « pickle » peut exécuter du code au chargement.
- À l'exécution : aucun réseau, lecture seule, utilisateur dédié, socket Unix
  ouvert au seul groupe de l'API. Le test l'a prouvé : sans le groupe, refusé.
- La CI rejoue le jeu de test dans l'image : une nouvelle révision du modèle qui
  tombe sous 21/24 bloque le déploiement. **Une mesure qui tourne en CI devient
  un garde-fou.**

Le test du client a aussi trouvé un vrai défaut : une réponse démesurée du
service faisait planter l'API (exception levée hors de la promesse). Un service
local reste une source non fiable.

## 4. Quand la mesure dit non : détecter les injections

Même modèle, autre question : « ce texte donne-t-il des ordres à l'assistant ? ».
Seuil choisi sur le banc et le jeu v1, mesure unique sur v2 (jamais vu) :

| | Attaques repérées | Textes légitimes signalés à tort |
|---|---|---|
| Heuristique actuelle | 0/12 | — |
| Laya, seuil calibré | **11/12** | **6/12** |

Tentant : 11/12 ! Mais un texte légitime sur deux signalé, c'est une alarme qui
sonne tout le temps : les utilisateurs apprennent à l'ignorer, et elle ne
protège plus rien. **Non déployé.** La défense qui compte reste structurelle
(règle de deux, marquage), indépendante du texte. On reprendra avec un modèle
entraîné sur nos propres cas (atelier d'entraînement, étape 6).

## À retenir

1. Déléguer = intersection des droits, validations qui remontent, budget commun.
2. Un état implicite de framework s'isole quand on imbrique.
3. Un seuil se choisit sur l'entraînement et se mesure **une fois** sur le test.
4. Un chiffre obtenu en connaissant le test est biaisé : le dire.
5. Une bonne détection avec trop de fausses alertes est une mauvaise détection.
6. Une mesure rejouée en CI empêche les régressions silencieuses.
