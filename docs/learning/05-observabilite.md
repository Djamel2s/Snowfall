# Fiche 5 — Observabilité des agents : OpenTelemetry et Langfuse

> Phase 1 du harness, étape 5 (dernière). Comprendre ce qu'un agent a fait,
> combien ça a coûté, et pourquoi il a répondu ça.

## 1. Le problème

Un agent répond mal. Pourquoi ? A-t-il cherché dans la base ? Avec quelle
requête ? L'outil a-t-il échoué ? Combien d'appels au modèle, combien de tokens,
le cache a-t-il servi ? Sans traces, on devine. Les métriques (Prometheus) disent
*combien* (latence, erreurs) ; les **traces** disent *quoi*, pour **une** réponse.

## 2. Le vocabulaire

- **Trace** : l'histoire d'une réponse, de bout en bout.
- **Span** : une opération dans cette histoire, avec un début, une fin, des
  attributs. Les spans s'emboîtent :

```
invoke_agent Juriste                         2,4 s   420 tokens (100 en cache)
├─ chat mistral:mistral-small-latest         0,8 s   → demande search_knowledge
├─ execute_tool search_knowledge             0,3 s   fait
└─ chat mistral:mistral-small-latest         1,2 s   → réponse
```

- **OpenTelemetry (OTel)** : le standard ouvert pour produire et transporter
  traces, métriques et journaux. Le code produit des spans OTel ; un « exporteur »
  les envoie (protocole **OTLP**) à l'outil de son choix.
- **Conventions GenAI** : les noms d'attributs standard pour l'IA
  (`gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.tool.name`…). Tous les outils les comprennent.
- **Langfuse** : un outil d'observabilité spécialisé pour les LLM (traces,
  coûts, sessions, évaluations), qu'on héberge nous-mêmes.

**Pourquoi le standard plutôt que le SDK de Langfuse ?** Le code ne dépend que
d'OpenTelemetry. Demain, on peut envoyer les mêmes traces à Grafana Tempo, à
Datadog, ou à deux outils à la fois, sans toucher au code de l'agent.

## 3. Comment c'est fait dans Snowfall

[tracing.ts](../../apps/api/src/observability/tracing.ts) :

- Le **graphe** de l'agent ne connaît qu'une petite interface (`AgentTrace`) :
  « un appel au modèle commence, se termine avec tant de tokens » ; « un outil
  commence, se termine avec tel statut ». Il ne sait rien d'OpenTelemetry. On
  peut le tester sans, et changer d'outil sans le toucher.
- Le **serveur** ouvre une trace par passage d'un run (lancement, reprise après
  validation, reprise après panne) et la referme avec son issue : terminé, en
  pause, arrêté, erreur, interrompu.
- **Session = conversation** : dans Langfuse, toutes les réponses d'une
  conversation sont regroupées ; l'utilisateur est un identifiant (pas un nom).
- Un outil en **attente de validation** termine son span avec le statut
  « waiting » : ce n'est pas une erreur.
- Une **erreur** est tracée par son type seulement, jamais par son message (il
  peut contenir des données).

## 4. La sécurité des traces

Une trace peut contenir la question, la réponse, les résultats d'outils : c'est
une **copie des données**. Chaque copie est un risque. D'où :

| Mesure | Détail |
|---|---|
| Hébergement interne | Langfuse sur le réseau interne, sans accès Internet, télémétrie coupée, interface sur la boucle locale |
| Masquage | e-mails, téléphones, IBAN, cartes, n° de sécurité sociale, IP, clés d'API remplacés avant l'envoi |
| Confidentiel | conversation sur une base confidentielle : **aucun** contenu, seulement les mesures |
| Mode « none » | `TRACE_CONTENT=none` : aucun contenu nulle part (tokens, durées, noms d'outils seulement) |
| Conservation | **30 jours** ; la rétention intégrée de Langfuse est réservée à son édition payante, donc l'API efface elle-même les traces plus anciennes, par l'API publique de Langfuse |
| Moindre privilège | base de Langfuse séparée de celle de Snowfall ; chaque service ne reçoit que ses propres secrets |
| Accès | comptes créés par l'administrateur, inscription libre fermée |

Le masquage est **au mieux** : il reconnaît des formats (un IBAN, un e-mail),
pas un nom dans une phrase. Pour des données très sensibles, choisis le mode
« none ».

## 5. L'installation

`compose.observability.yaml` (facultatif) ajoute Langfuse et ce dont il a besoin :

| Service | Rôle |
|---|---|
| langfuse-web | interface et réception des traces (OTLP) |
| langfuse-worker | traitement en arrière-plan |
| PostgreSQL (dédié) | comptes, projets, réglages |
| ClickHouse | stockage analytique des traces |
| Redis | files de traitement |
| Garage | stockage objet S3 (événements bruts) |

`infra/langfuse/bootstrap.sh` génère les secrets, prépare le stockage et crée le
projet et ses clés.

**On l'a vérifié en vrai** (une trace envoyée par notre code, relue par l'API
de Langfuse, puis effacée). Le test a trouvé six pièges qu'aucun test unitaire
n'aurait vus :

| Piège | Correction |
|---|---|
| Langfuse 4.49 exige un ClickHouse récent (index plein texte) | ClickHouse 26.3 |
| `localhost` vise IPv6, désactivé sur le réseau | vérification de santé sur `127.0.0.1` |
| Garage refuse un secret lisible par tous | bonne protection : sous Linux, le script crée ses fichiers en 0600 |
| Redis, privé de toutes ses capacités, ne peut plus préparer son dossier | trois capacités rendues (CHOWN, SETGID, SETUID), pas plus |
| Next.js n'écoute que sur l'adresse liée au nom du conteneur | `HOSTNAME=0.0.0.0` |
| Langfuse v4 : l'ancienne API de liste des traces n'existe plus, et l'effacement est **asynchrone** | liste par les observations racines (API v2), chaque trace demandée une seule fois |

Et ce qu'il a confirmé : Langfuse reconnaît les conventions GenAI (réponse
`AGENT`, appels `GENERATION`, outil `TOOL`), relit les tokens servis par le cache,
regroupe par session, et reçoit la question masquée (« Mon e-mail est [email]… »).

Retiens : **une intégration se teste contre le vrai service**. La documentation
décrivait une API qui n'existait plus dans la version installée.

## 6. Ce que tu peux faire avec

- Retrouver **pourquoi** une réponse est fausse : quelle recherche, quels extraits.
- Voir le **coût** par agent, par utilisateur, par jour.
- Vérifier que le **cache** sert vraiment (tokens en cache dans chaque appel).
- Repérer les **outils lents** ou qui échouent souvent.
- Plus tard : **évaluer** (noter des réponses, comparer deux versions d'un prompt).

## Pour vérifier que tu as compris

1. Quelle différence entre une métrique et une trace ? Donne un exemple de
   question à laquelle seule une trace répond.
2. Pourquoi le graphe ne dépend-il pas directement d'OpenTelemetry ?
3. Pourquoi ne trace-t-on jamais le message d'une erreur ?
4. Une conversation utilise une base confidentielle. Que contient sa trace ?
5. Pourquoi effacer nous-mêmes les traces de plus de 30 jours ?

## Glossaire

- **Trace / span** : l'histoire d'une requête, et chacune de ses opérations.
- **OTLP** : le protocole d'envoi d'OpenTelemetry (ici en HTTP).
- **Exporteur** : composant qui envoie les spans vers un outil.
- **Échantillonnage** : ne garder qu'une partie des traces (pas utilisé ici :
  toutes les réponses sont tracées).
- **Session** : regroupement de traces (ici, une conversation).

**Fin de la phase 1.** Prochaine phase : les outils (recherche web, artifacts,
interpréteur de code, MCP).
