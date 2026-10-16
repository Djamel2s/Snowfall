# Fiche 4 — Cache de prompt, compaction et raisonnement visible

> Phase 1 du harness, étape 4. Trois façons de mieux gérer le **contexte** : ce
> que le modèle relit à chaque appel.

## 0. Rappel : le modèle n'a aucune mémoire

À chaque appel, on renvoie **tout** : prompt système, outils, historique, message.
Une conversation de 50 échanges, c'est 50 échanges relus, payés et attendus à
chaque nouveau message. D'où trois problèmes : le **coût**, la **latence**, et la
**fenêtre de contexte** (au-delà, le modèle ne peut plus tout lire).

## 1. Le cache de prompt

### L'idée

Le fournisseur garde en mémoire le **début** d'une requête déjà vue. Si la
requête suivante commence **exactement** pareil, ce début est relu du cache :
environ **10 fois moins cher** chez Anthropic, et nettement plus rapide.

```
tour 1 : [système][outils][msg1][rép1][msg2]                  ← tout est calculé
tour 2 : [système][outils][msg1][rép1][msg2][rép2][msg3]       ← début relu du cache
          └────────────── identique ──────────────┘
```

### Par fournisseur

| Fournisseur | Fonctionnement | Dans Snowfall |
|---|---|---|
| Anthropic | demandé explicitement (`cache_control`) | cache automatique : tout jusqu'au dernier bloc |
| OpenAI | automatique au-delà de 1 024 tokens | début de requête rendu stable |
| Gemini 2.5+ | automatique (cache implicite) | idem |
| Mistral | pas de cache exposé | — |

### La règle d'or : un préfixe stable

Le cache ne marche que si le début est **identique à l'octet près**. Ce qui le
casse sans prévenir :

- une date ou un identifiant dans le prompt système ;
- des outils qui changent d'ordre d'un tour à l'autre ;
- un ancien message réécrit (il faut ajouter à la fin, jamais modifier le début).

C'est pour cela que le résumé de compaction est placé **à la fin** du prompt
système, et qu'il change rarement.

### Mesurer

On compte les tokens servis par le cache (`cachedInputTokens`) : dans l'audit de
chaque réponse, et dans la métrique `snowfall_llm_tokens_total{direction="cached_input"}`.
Le rapport cache/entrée dit si le cache fonctionne. S'il reste à zéro sur une
longue conversation, quelque chose casse le préfixe.

## 2. La compaction

### Avant : la coupure

On envoyait les 20 derniers messages. Au 21ᵉ, le premier disparaissait :
l'agent « oubliait » le budget annoncé au début.

### Maintenant : le résumé

```
prompt système + <conversation_summary> résumé des échanges anciens </conversation_summary>
+ messages récents, tels quels, dans un budget de 12 000 tokens
```

[compaction.ts](../../apps/api/src/conversations/compaction.ts) :

1. **Quand ?** Après une réponse, si l'historique non résumé dépasse 8 000 tokens.
2. **Quoi ?** Tout, sauf les 6 derniers messages (le fil immédiat reste exact),
   en s'arrêtant sur une réponse de l'assistant : on ne coupe jamais un échange.
3. **Comment ?** Le modèle de la conversation produit un résumé en puces, qui
   **intègre le résumé précédent** : la compaction est incrémentale.
4. **En arrière-plan** : la réponse n'attend pas le résumé ; en cas d'échec, on
   retombe sur la coupure, sans erreur pour l'utilisateur.

### Les détails qui comptent

- **L'historique affiché reste intact.** Le résumé n'est donné qu'au modèle.
- **Modifier un ancien message invalide le résumé** : s'il couvrait la partie
  modifiée, il décrirait une autre histoire. Il est alors ignoré, puis refait.
- **Le résumé est une donnée, pas une instruction.** Un message piégé
  (« ignore tes règles ») pourrait se retrouver résumé, puis lu comme une consigne.
  D'où les balises, la règle dans le prompt système, et la neutralisation des
  balises dans le texte.
- **Même modèle que la conversation** : une conversation confidentielle (modèle
  local) est résumée en local. Les données ne vont nulle part où elles ne sont
  pas déjà allées.
- **Chiffré, sous RLS, effacé avec la conversation**, et sa consommation est
  comptée dans le quota.

### Compromis

Un résumé **perd** des détails : c'est le prix. Pour un document long, mieux vaut
le mettre dans la **base de connaissances** (fiche RAG) : il sera retrouvé
précisément, au lieu d'être résumé.

## 3. Le raisonnement visible

Les modèles récents **réfléchissent** avant de répondre. On affiche cette
réflexion **résumée par le fournisseur**, dans un bloc repliable : ouvert pendant
qu'il réfléchit, replié dès que la réponse commence.

| Fournisseur | Réglage |
|---|---|
| Anthropic (génération 5) | `thinking: { type: "adaptive", display: "summarized" }` : le modèle décide quand et combien réfléchir |
| Gemini 2.5 et 3 | `thinkingConfig: { includeThoughts: true }` |
| Serveurs locaux (vLLM, Ollama…) | champ `reasoning_content` lu s'il existe |
| OpenAI | le texte de la réflexion n'est pas exposé par cette API |

### Le piège technique : renvoyer la réflexion intacte

Pendant une boucle d'outils, Anthropic exige qu'on renvoie le tour du modèle
**exactement** tel qu'il l'a produit, blocs de réflexion **signés** compris. La
signature lie la réflexion à la conversation : un bloc modifié, retiré ou
reconstruit est refusé. On garde donc le contenu brut du tour
(`providerData.anthropicContent`) et on le renvoie tel quel. C'est le même
principe que la signature de raisonnement de Gemini (fiche 1).

### Choix de sécurité : la réflexion n'est jamais enregistrée

Elle est visible pendant la réponse, et reste consultable pendant ta session.
Elle n'est **pas** enregistrée avec les messages, par **minimisation**. Une
réflexion reformule souvent des données sensibles, et elle n'apporte rien de
plus que la réponse à long terme. Pendant une réponse en cours, elle est gardée
chiffrée avec l'avancement du run (pour une reconnexion), puis effacée avec lui.

Un rappel : la réflexion affichée est un **aperçu**, pas une preuve. Un modèle
peut écrire une chose et en faire une autre. Ce qui fait foi, ce sont les
**actions** (outils appelés, validations), tracées dans l'audit.

## 4. Tests

| Test | Ce qu'il prouve |
|---|---|
| [compaction.test.ts](../../apps/api/src/conversations/compaction.test.ts) | budget, résumé ignoré après une modification, seuil et repli d'échanges complets, résumé enrichi, balises neutralisées, réflexion diffusée à part et blocs renvoyés intacts, tokens du cache additionnés |
| [runs.routes.test.ts](../../apps/api/src/agent/runs.routes.test.ts) | une longue conversation est résumée en arrière-plan, puis le résumé remplace le début ; l'audit ne contient pas le résumé |
| [runs.integration.test.ts](../../apps/api/src/agent/runs.integration.test.ts) | résumé chiffré en base, invisible d'une autre organisation, effacé avec la conversation |
| [google.test.ts](../../apps/api/src/llm/google.test.ts) | réflexion demandée et diffusée à part ; tokens du cache comptés |

## Pour vérifier que tu as compris

1. Tu ajoutes l'heure courante au prompt système « pour que l'agent sache quel
   jour on est ». Que devient le cache ? Où mettre cette information à la place ?
2. Pourquoi ne jamais résumer les 6 derniers messages ?
3. Un utilisateur modifie son 3ᵉ message dans une conversation de 60 messages.
   Que devient le résumé, et pourquoi ?
4. Pourquoi le résumé est-il fait par le modèle de la conversation, et pas par un
   modèle moins cher chez un autre fournisseur ?
5. Pourquoi ne peut-on pas « nettoyer » les blocs de réflexion avant de les
   renvoyer à Anthropic ?

## Glossaire

- **Préfixe** : le début d'une requête, identique d'un appel à l'autre ; c'est ce
  que le cache réutilise.
- **Compaction** : remplacer des échanges anciens par leur résumé pour tenir dans
  un budget de contexte.
- **Fenêtre de contexte** : quantité maximale de tokens qu'un modèle peut lire en
  une fois.
- **Réflexion adaptative** : le modèle décide lui-même s'il doit réfléchir, et
  combien, selon la difficulté.
- **Minimisation** : ne garder que les données nécessaires, le moins longtemps
  possible (principe du RGPD).

**Prochaine étape :** observabilité, avec OpenTelemetry et Langfuse auto-hébergé
(traces de chaque réponse, coût, latence, données personnelles masquées).
