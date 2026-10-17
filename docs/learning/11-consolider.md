# Fiche 11 — Consolider : prouver, vérifier, ranger

> Sprint 0. Aucune nouvelle fonction : on rend vérifiable ce qui existe.

## 1. Pourquoi s'arrêter

Après deux phases rapides, trois symptômes : des défauts trouvés *après* coup,
une documentation de sécurité restée au 14 octobre, et des réglages devenus un
fourre-tout. Ajouter une fonction de plus aurait aggravé les trois.

## 2. Une preuve, c'est un test qu'on peut relancer

| Avant | Après |
|---|---|
| Batterie d'attaques du bac à sable lancée à la main, une fois | `scripts/sandbox-attack.sh`, en CI à chaque modification |
| « L'écran a l'air bien » | Tests d'écran Playwright, bureau et mobile, en CI |
| Contrôles décrits jusqu'au 14/10 | `SECURITY_BASELINE.md` à jour, modèle de menaces, trame d'AIPD |

**Retiens :** pour un auditeur, un contrôle non décrit n'existe pas. Pour un
développeur, un contrôle non testé finira par casser sans bruit.

## 3. Les tests d'écran ont trouvé ce que les autres ne voyaient pas

On teste l'interface réelle dans un vrai navigateur, l'API étant remplacée par
des réponses fictives (`e2e/mock-api.ts`). Dès le premier parcours, deux défauts :

1. **Saisie impossible sur l'écran d'accueil** : la zone de texte restait
   désactivée tant qu'on n'avait pas cliqué « Nouvelle conversation ». La
   conversation est maintenant créée au premier envoi.
2. **Réponse affichée deux fois** pendant un instant : le texte en cours et le
   message enregistré cohabitaient pendant une requête de rafraîchissement.

Aucun test unitaire ne pouvait les voir : ce sont des défauts d'*enchaînement*.

## 4. Fail-closed : échouer du côté sûr

Le bac à sable vérifie qu'il tourne sous gVisor. Si la vérification se trompe,
il **refuse de démarrer** : l'interpréteur est indisponible, mais jamais moins
isolé. Même logique pour MCP sans proxy en production : l'API refuse de démarrer.

**Retiens :** quand un contrôle de sécurité ne peut pas conclure, la réponse par
défaut est « non ».

## 5. Borner le coût

Trois plafonds, pour trois façons de dépenser :

| Plafond | Protège contre |
|---|---|
| Budget de tokens par réponse | Une boucle d'agent qui relit un contexte énorme à chaque étape |
| Durée maximale par réponse | Un outil ou un modèle bloqué |
| Quotas mensuels d'outils | L'exécution de code, la recherche et MCP, dont le coût n'apparaît pas dans les tokens |

## Pour vérifier que tu as compris

1. Pourquoi un test d'écran avec une API fictive, plutôt qu'avec la vraie ?
2. Que se passe-t-il si la détection de gVisor se trompe ? Pourquoi est-ce acceptable ?
3. Pourquoi le budget de tokens retire-t-il les outils au lieu d'arrêter la réponse ?
