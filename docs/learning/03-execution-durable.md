# Fiche 3 — L'exécution durable

> Phase 1 du harness, étape 3. Comment une réponse d'agent survit à une coupure
> réseau, à une pause de plusieurs heures et à un redémarrage du serveur.

## 1. Le problème

Jusqu'ici, une réponse vivait **dans la mémoire d'un processus**, attachée à une
connexion HTTP :

| Événement | Avant |
|---|---|
| Tu fermes l'onglet | la réponse s'arrête |
| Le réseau coupe 3 secondes | la réponse s'arrête |
| L'agent attend ta validation | le serveur garde la boucle en mémoire, au plus 5 min |
| Le serveur redémarre (déploiement, panne) | tout est perdu |
| Deux instances de l'API | ta validation doit tomber sur la bonne |

Un agent qui travaille plusieurs minutes, ou qui attend un humain, ne peut pas
dépendre d'une connexion. Il faut une **exécution durable** : l'état est
enregistré, et le travail reprend où il s'était arrêté.

## 2. Les trois idées

### a) Le run : la réponse devient un objet en base

Chaque réponse est un **run** (table `agent_runs`) : statut (`running`,
`waiting`), demande d'origine, avancement, et un **bail** (*lease*). La connexion
HTTP ne fait plus qu'**observer** le run : elle reçoit les événements (`token`,
`step`, `approval`…), mais la fermer n'arrête rien. « Arrêter » est maintenant
une action explicite : `POST /conversations/:id/run/cancel`.

### b) Le point de reprise (checkpoint) après chaque étape

LangGraph sait enregistrer l'**état complet du graphe** (transcription, texte,
compteurs) à chaque « super-étape », grâce à un **checkpointer**. On l'a branché
sur PostgreSQL, **chiffré avec la clé de l'organisation**
([checkpointer.ts](../../apps/api/src/agent/checkpointer.ts)).

Le détail qui change tout : les **écritures intermédiaires** (*pending writes*).
Chaque appel d'outil est une **tâche** distincte (`Send`), et son résultat est
enregistré **dès qu'il existe**, avant la fin de l'étape. À la reprise :

- une tâche terminée n'est **jamais relancée** ;
- seule la tâche interrompue est rejouée.

On l'a vérifié par un test : un outil de lecture s'exécute, l'instance tombe
pendant l'étape suivante, une autre instance reprend, et l'outil n'a tourné
**qu'une fois**.

### c) La pause : `interrupt()`

Pour un outil d'écriture, au lieu d'attendre en mémoire, la tâche appelle
`interrupt()` : LangGraph enregistre l'état et **arrête** le graphe. Le serveur
libère tout ; le run passe à `waiting`. Ta décision arrive plus tard (5 secondes
ou 5 heures), sur **n'importe quelle instance** :

```
POST …/approvals/:id {approved}  →  Command({ resume: { [id]: true } })
```

Le graphe reprend **exactement** à cet `interrupt()`, qui renvoie ta décision.
Avec deux écritures en parallèle, chacune a son identifiant et se tranche
séparément.

## 3. Le bail : qui exécute quoi ?

Plusieurs instances de l'API peuvent tourner. Une seule doit exécuter un run.

1. L'instance qui exécute **prend un bail** de 30 s et le **renouvelle** toutes
   les 10 s, en enregistrant l'avancement au passage (texte partiel, étapes).
2. Si elle tombe, le bail **expire**. Toutes les 30 s, chaque instance cherche les
   runs orphelins (`snowfall_stale_runs`) et en **reprend** un, de façon atomique
   (`UPDATE … WHERE lease_until < now()` : une seule gagne).
3. Si une instance découvre en renouvelant que son bail lui a été pris, elle
   s'arrête : pas de double exécution.
4. Une validation restée sans réponse **24 h** est refusée, et la réponse se termine.

C'est le même principe que les verrous des systèmes distribués (Temporal, les
files de messages) : le bail évite qu'un run reste orphelin ou tourne deux fois.

## 4. Sécurité et données

| Exigence | Ce qui est fait |
|---|---|
| Confidentialité | demande, avancement, points de reprise : **chiffrés** (AES-256-GCM, clé de l'organisation, AAD liée au run) ; contrainte SQL qui refuse le clair |
| Isolation | RLS imposée (`FORCE`) : un run n'est visible que de son propriétaire |
| Reprise en arrière-plan | la file de reprise ne contient que des **identifiants** ; le rôle applicatif n'y a aucun droit ; chaque run est repris **sous la RLS de son propriétaire**, avec son **rôle actuel** (un membre retiré n'est pas repris) |
| Droits revérifiés à la reprise | modèle toujours autorisé, outils recalculés (organisation, agent), base confidentielle toujours sur modèle local |
| Minimisation | run terminé : la ligne et tous ses points de reprise sont **effacés** |
| Audit | chaque décision (approuvée, refusée, expirée, annulée) est tracée, jamais le contenu |

Un piège trouvé en testant : la fonction de reprise lisait `agent_runs` en tant
que propriétaire de la table. Or `FORCE ROW LEVEL SECURITY` s'applique **aussi au
propriétaire** : elle n'aurait jamais rien vu. On a repris le motif des imports
de connaissances : une petite file d'identifiants tenue à jour par trigger.
Retiens-le : **teste toujours la sécurité sur une vraie base**, les tests en
mémoire ne voient pas ces subtilités.

## 5. La limite honnête : « au moins une fois »

Si l'instance tombe **pendant** l'exécution d'un outil d'écriture (après l'effet,
avant l'enregistrement du résultat), l'outil sera rejoué à la reprise. C'est la
garantie « au moins une fois » (*at-least-once*). L'exécution « exactement une
fois » demande que l'outil soit **idempotent** : il reconnaît une demande déjà
traitée grâce à une **clé d'idempotence** (par exemple l'identifiant de l'appel).
Les futurs outils d'envoi (e-mail, API) devront l'utiliser.

## 6. Ce que tu vois dans l'interface

- **Fermer l'onglet** ne coupe plus la réponse : rouvre la conversation, la
  question, le texte et les étapes réapparaissent, puis la suite arrive en direct.
- **Une validation en attente** est toujours là à ton retour, même après un
  redémarrage du serveur.
- **« Arrêter »** prévient le serveur ; la réponse partielle est gardée.
- **Une seule réponse à la fois** par conversation : un second envoi pendant une
  pause est refusé avec un message clair.

## 7. Tests

| Test | Ce qu'il prouve |
|---|---|
| [runs.routes.test.ts](../../apps/api/src/agent/runs.routes.test.ts) | pause puis reconnexion puis reprise ; validation tranchée par **une autre instance** ; un autre utilisateur ne voit rien ; onglet fermé : la réponse est quand même enregistrée ; arrêter garde le partiel ; **panne en pleine étape : reprise sans relancer l'outil** ; validation expirée : refus |
| [runs.integration.test.ts](../../apps/api/src/agent/runs.integration.test.ts) | sur PostgreSQL : une réponse active par conversation, bail exclusif, RLS entre organisations, **aucun clair en base**, file de reprise inaccessible, points de reprise chiffrés puis effacés |

## Pour vérifier que tu as compris

1. Pourquoi la fermeture de la connexion ne doit-elle plus arrêter la réponse ?
   Qu'est-ce qui l'arrête maintenant ?
2. Quelle différence entre un point de reprise (*checkpoint*) et une écriture
   intermédiaire (*pending write*) ? Laquelle évite de relancer un outil ?
3. Deux instances voient le même run orphelin au même moment. Pourquoi une seule
   le reprend-elle ?
4. Pourquoi revérifier les droits (modèle, outils, rôle) à la reprise, alors
   qu'ils l'ont été au départ ?
5. Un outil « envoyer un e-mail » est rejoué après une panne. Que faut-il pour que
   le destinataire ne reçoive pas deux e-mails ?

## Glossaire

- **Exécution durable** : un travail dont l'état est enregistré, qui survit aux
  pannes et reprend où il s'était arrêté.
- **Checkpointer** : composant qui enregistre l'état du graphe LangGraph à chaque
  étape.
- **`interrupt()` / `Command({ resume })`** : pause d'un graphe en attente d'une
  donnée externe (ici ta décision), puis reprise avec cette donnée.
- **Bail (lease)** : droit d'exécution limité dans le temps, renouvelé tant que
  l'instance est vivante.
- **Idempotence** : refaire une opération ne change pas le résultat (une
  deuxième demande identique est reconnue et ignorée).

**Prochaine étape :** cache de prompt, compaction des longues conversations et
raisonnement visible.
