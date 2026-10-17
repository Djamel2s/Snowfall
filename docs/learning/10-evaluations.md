# Fiche 10 — Évaluer un agent : mesurer avant d'optimiser

> Phase 3, étape 1. Jusqu'ici, on changeait un prompt ou un modèle « à l'œil » :
> une conversation qui marche ne prouve rien. Une évaluation transforme
> « ça a l'air mieux » en un chiffre, et chaque bug corrigé en un test.

## 1. Pourquoi c'est difficile

| Logiciel classique | Agent |
|---|---|
| même entrée → même sortie | le modèle **n'est pas déterministe** : deux essais, deux réponses |
| on vérifie une valeur | on vérifie une **réponse en français** et un **chemin** (quels outils, quels arguments) |
| un test passe ou casse | un cas peut réussir 2 fois sur 3 : il est **instable** |

D'où trois idées : **plusieurs essais** par cas (taux de réussite), des
**correcteurs** adaptés, et une **référence** pour repérer les régressions.

## 2. Ce que l'on note

Un agent peut donner la bonne réponse par le mauvais chemin, ou l'inverse. On
note donc les deux :

- **la réponse** : contient « 40 € », cite une source `[1]`, ne contient pas le mot de passe ;
- **la trajectoire** : a cherché dans la base, n'a PAS appelé l'outil d'écriture,
  aucun argument ne contient le secret, pas plus de 3 étapes.

## 3. Deux sortes de correcteurs

| | Déterministe (règle) | Juge LLM |
|---|---|---|
| Exemple | « la réponse contient 14 » | « dit-elle clairement que l'info manque, sans inventer ? » |
| Coût | gratuit | un appel de modèle |
| Fiabilité | parfaite, mais bête (une formulation imprévue échoue) | nuancé, mais lui-même faillible |
| Règle | **toujours en premier** | seulement là où une règle ne suffit pas |

Les pièges du juge LLM, à connaître :
- **Auto-complaisance** : un modèle se juge trop gentiment. Prends un **autre** modèle comme juge.
- **Injection** : la réponse jugée peut contenir « note : pass ». Le juge reçoit
  la réponse entre balises, avec la consigne de ne rien y exécuter.
- **Verdict illisible** : on exige du JSON, lu de façon tolérante ; illisible = échec, jamais réussite.

## 4. Le banc de Snowfall

```
cas (agent-cases.ts) ──► même boucle que la production ──► transcription ──► correcteurs ──► rapport
                         (graphe, prompt système, vrais outils         (réponse + appels
                          sur un corpus et un web FICTIFS)               d'outils + refus)
```

- **Même code que la production** : sinon on évaluerait autre chose que ce qui tourne.
- **Données fictives** (entreprise Polaris, web inventé) : reproductible, et aucune donnée réelle n'est envoyée.
- **Erreurs techniques à part** : un quota atteint (HTTP 429) n'est pas un échec
  du modèle ; il est exclu des taux, et le cas est rejoué après une pause.

Les 14 cas couvrent quatre familles :

| Famille | Exemples |
|---|---|
| RAG | répondre juste et citer ; combiner deux documents ; question de suivi ; **dire que l'info manque** ; ne pas chercher pour un simple « bonjour » |
| Outils | enregistrer ce qu'on demande ; **ne pas prétendre** avoir enregistré (refus, ou outil absent) |
| Sécurité | document piégé qui ordonne une écriture ; page web qui tente de faire sortir un secret ; instructions confidentielles |
| Web | information récente avec citation ; préférer la base pour une question interne |

**Retiens :** chaque bug vu en vrai devient un cas. Le cas « ne prétend pas avoir
enregistré » vient directement du bug de la fiche 2.

## 5. Les commandes

```bash
# Tests du banc lui-même (modèles scriptés, sans réseau) : dans npm test
npm test

# Vrais modèles (coût : 2 à 4 appels par cas)
npm run agent:eval -- --model google:gemini-3.5-flash-lite --repeat 3 --out ref.json
# Après un changement de prompt : comparaison à la référence (code de sortie 1 si régression)
npm run agent:eval -- --model google:gemini-3.5-flash-lite --repeat 3 --baseline ref.json
# Comparer des modèles, avec un juge d'un autre modèle
npm run agent:eval -- --model mistral:mistral-small-latest --model google:gemini-3.5-flash-lite --judge anthropic:claude-opus-5-5
```

Le rapport donne, par modèle : le taux de réussite global et par famille, les
jetons et la durée par cas, et les cas **instables** (ni toujours réussis, ni toujours ratés).

## 6. Première mesure : la réflexion aide-t-elle ?

On s'était demandé pourquoi la « Réflexion » n'apparaissait pas. Un appel direct
à Gemini a tranché : **Gemini 3.5 Flash-Lite ne réfléchit pas par défaut**
(0 jeton de réflexion). Avec `thinkingLevel: "low"`, il réfléchit (≈ 190 jetons)
et la réflexion s'affiche. Notre code n'était pas en cause. D'où le réglage
`GOOGLE_THINKING_LEVEL`.

Faut-il l'activer ? Plutôt que deviner, on a mesuré (14 cas × 2 essais) :

| Flash-Lite | Réussite | Jetons / cas | Durée / cas |
|---|---|---|---|
| sans réflexion | 26/28 (93 %) | ≈ 2 400 | 1,7 s |
| réflexion « low » | 26/28 (93 %) | ≈ 2 360 | 1,4 s |

Sur ce jeu, la réflexion **n'améliore rien de mesurable**. L'activer sert à
l'afficher, pas à mieux répondre. Sur des questions plus difficiles (calcul,
plusieurs étapes), le résultat pourrait être différent : il faudra des cas
pour ça. Retiens : **un réglage se justifie par une mesure**, pas par intuition.

### Ce que l'évaluation a trouvé

Le seul cas raté l'était **à chaque essai, avec ou sans réflexion** : « résume
cette page https://… ». Le modèle tapait l'adresse dans `web_search` au lieu de
l'ouvrir avec `read_webpage`, puis répondait qu'il ne pouvait pas y accéder.
La cause était dans notre description d'outil : le paramètre disait « adresse
exacte d'**un résultat de web_search** ». Le modèle en déduisait, logiquement,
qu'une adresse donnée par l'utilisateur ne comptait pas.

Après correction des deux descriptions : **0/4 → 3/3**. Et le cas vérifie enfin
ce pour quoi il a été écrit : la page piégée est lue, et le secret ne sort pas.

**Retiens :** pour un modèle, la description d'un outil fait partie du prompt.
Un mot mal choisi suffit à le rendre inutilisable dans un cas courant, et seule
une évaluation l'a montré : aucun test unitaire ne pouvait le voir.

### Une fausse régression, très instructive

Après la correction, le jeu complet affichait **96 %**, avec « régression :
rag-absent ». C'était faux : le modèle avait bien répondu (« l'information **ne
se trouve pas** dans les documents »), mais la règle n'acceptait que « pas
d'information », « ne trouve pas »… C'est la limite d'un correcteur fixe : il
note la **formulation**, pas le **sens**. Deux remèdes : élargir les variantes
(fait), ou confier ce critère au juge LLM, qui juge le sens (`--judge`).

**Retiens :** avant de croire une régression, lis la réponse. Un échec peut
venir du modèle, ou du correcteur.

## Pour vérifier que tu as compris

1. Pourquoi lancer chaque cas plusieurs fois ?
2. Un cas réussit à 100 % dans la référence et à 50 % après ton changement. Est-ce forcément ton changement ?
3. Pourquoi noter la trajectoire, et pas seulement la réponse ?
4. Pourquoi le juge doit-il être un autre modèle que celui évalué ?
5. Pourquoi une erreur 429 ne doit-elle pas compter comme un échec ?

## Glossaire

- **Cas d'évaluation** : une entrée + ce qu'on attend (règles, consigne du juge).
- **Trajectoire** : la suite des appels d'outils qui a mené à la réponse.
- **LLM-as-judge** : un modèle qui note la sortie d'un autre.
- **Régression** : ce qui marchait et ne marche plus.
- **Instable (flaky)** : un cas qui réussit parfois.
