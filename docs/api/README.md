# API Snowfall (v1)

Pour qu'une application de votre organisation (intranet, outil interne, bot)
parle aux agents Snowfall. Appels **de serveur à serveur** uniquement : une clé
d'API ne doit jamais se trouver dans un navigateur ni dans une application mobile.

## Obtenir une clé

Un administrateur ouvre **Administration › Outils et intégrations ›
Clés d'API**. Il choisit :

- un nom (« Intranet RH ») ;
- les agents permis (20 au plus) ;
- une durée de validité (30, 90, 180 ou 365 jours).

La clé (`snowfall_sk_…`, 58 caractères) n'est affichée **qu'une fois**. Elle se
garde comme un mot de passe, par exemple dans le coffre de secrets de
l'application.

Ce que fait une clé :

- elle **agit au nom de l'administrateur qui l'a créée** : ses quotas, ses
  droits sur les données, son journal d'audit ;
- elle ne sert **que** si ce créateur est toujours administrateur : s'il est
  rétrogradé ou s'il quitte l'organisation, la clé cesse de fonctionner ;
- elle ne donne accès qu'aux routes `/v1` et aux agents listés ;
- elle ne valide **jamais** une écriture : l'agent qui veut enregistrer,
  envoyer ou modifier quelque chose attend une personne, dans Snowfall.

## Authentification

```
Authorization: Bearer snowfall_sk_…
```

Adresse de base : `https://<votre-snowfall>/api/v1`.

## Routes

### Lister les agents permis

```
GET /v1/agents
```

```json
{ "agents": [{ "id": "8c1e…", "name": "Support RH" }] }
```

### Envoyer un message à un agent

```
POST /v1/agents/{agent_id}/messages
Content-Type: application/json

{ "content": "Combien de jours de télétravail ?", "conversation_id": "…" }
```

`conversation_id` est facultatif. Sans lui, une nouvelle conversation est créée.
Avec lui, la conversation continue, à condition d'être une conversation avec
**cet** agent.

Réponse `200` (réponse terminée) :

```json
{
  "conversation_id": "5f2a…",
  "status": "completed",
  "message": { "id": "…", "content": "Jusqu'à trois jours par semaine [1].", "sources": […] }
}
```

Réponse `202` (validation demandée) : l'agent veut faire une action qui écrit.
Rien n'est fait tant qu'une personne ne l'a pas validée dans Snowfall, dans la
conversation (visible dans l'historique du créateur de la clé).

```json
{ "conversation_id": "5f2a…", "status": "needs_approval", "approvals": [{ "tool": "save_to_knowledge", "title": "Enregistrer dans la base" }] }
```

### Relire une conversation

```
GET /v1/conversations/{conversation_id}
```

Sert notamment à récupérer la réponse une fois l'action validée. Seules les
conversations avec un agent permis à la clé sont lisibles.

```json
{ "conversation_id": "5f2a…", "agent_id": "8c1e…", "messages": [{ "role": "user", "id": "…", "content": "…" }, { "role": "assistant", "id": "…", "content": "…" }] }
```

## Exemple

```bash
curl -s https://snowfall.example/api/v1/agents/8c1e…/messages \
  -H "Authorization: Bearer $SNOWFALL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content": "Résume la politique de télétravail"}'
```

## Erreurs

| Code | Sens |
|---|---|
| 400 | Requête invalide (contenu vide, plus de 20 000 caractères, champ inconnu) |
| 401 | Clé absente, fausse, révoquée, expirée, ou créateur qui n'est plus administrateur |
| 404 | Agent non permis à la clé, ou conversation d'un autre agent |
| 409 | Une réponse est déjà en cours dans cette conversation |
| 429 | Trop d'appels (60 par minute et par clé) ou quota de l'organisation atteint |
| 502 | La réponse a échoué (fournisseur de modèle indisponible…) |

## Ce que l'API garantit

- Chaque message passe par **la même route** que l'interface : quotas, routage
  des modèles, règle de deux, détection des données sensibles et audit sont
  identiques.
- Les conversations créées par l'API sont **visibles** dans Snowfall, dans
  l'historique du créateur de la clé.
- Le journal d'audit trace chaque appel (`api.request`, avec la clé et la route)
  et chaque échec d'authentification (`api.auth_failed`, avec le début de la clé
  seulement). La clé elle-même n'est jamais enregistrée, seule son empreinte
  SHA-256 l'est.
- Une clé compromise se **révoque** d'un clic, avec effet immédiat.
