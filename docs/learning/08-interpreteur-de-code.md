# Fiche 8 — L'interpréteur de code : exécuter le code d'un modèle côté serveur

> Phase 2, outil 3. Le plus dangereux de tous : du code écrit par un modèle
> (peut-être manipulé) s'exécute sur nos machines.

## 1. Le besoin

Calculer une moyenne sur 300 lignes, tracer un graphique, produire un tableur :
un modèle se trompe en calcul mental, un programme non. L'agent écrit donc du
Python, on l'exécute, il lit le résultat (et peut corriger son code).

## 2. La menace

Le code peut avoir été écrit sous l'influence d'un document piégé. Il peut
essayer de : sortir sur Internet avec des données, attaquer la base ou l'API,
lire les secrets, voir les fichiers d'un autre utilisateur, saturer la machine,
survivre à son exécution. **Chaque point doit être bloqué par construction**, pas
par la bonne volonté du modèle.

## 3. L'architecture

```
API ──(socket Unix, volume partagé, groupe 10010)──► bac à sable (aucun réseau)
                                                       └─ exécution : utilisateur dédié,
                                                          dossier neuf, limites, puis tout est tué
```

| Couche | Ce qu'elle bloque |
|---|---|
| `network_mode: none` | aucune interface réseau : ni Internet, ni la base, ni l'API |
| Socket Unix réservé à un groupe | le code exécuté (autre utilisateur) ne peut pas s'y connecter pour lancer d'autres exécutions |
| Un utilisateur par emplacement (10001, 10002) | une exécution ne voit pas l'autre ; à la fin, **tous** ses processus sont tués |
| Limites (`setrlimit`) | temps CPU, mémoire (1,5 Go), 64 processus, taille de fichier, nombre de fichiers ouverts |
| Environnement vide | aucune variable héritée, donc aucun secret à voler |
| Fichiers privés (`umask 077`), `/tmp` et `/dev/shm` fermés | rien ne passe d'une exécution à la suivante |
| Système en lecture seule, `no-new-privileges`, 4 capacités seulement | pas d'écriture hors du dossier, pas d'élévation |
| `init: true` (tini) | les processus orphelins sont récupérés |
| gVisor (`SANDBOX_RUNTIME=runsc`) en production | le noyau de l'hôte n'est pas exposé directement |
| Antivirus sur les fichiers produits | un fichier dangereux ne sort pas |

Le serveur du bac à sable est écrit en Python **sans aucune dépendance** ; les
bibliothèques d'analyse (numpy, pandas, matplotlib, openpyxl) sont figées par
**empreinte** (`--require-hashes`), toutes publiées depuis plus de deux semaines.

## 4. On l'a attaqué, et il avait des failles

Une batterie d'attaques a tourné contre le vrai conteneur, durci comme en
production. Le premier passage a révélé **quatre problèmes**, corrigés ensuite :

| Attaque | Premier passage | Correction |
|---|---|---|
| Processus détaché (`fork` + `setsid`) | aurait échappé à « tuer le groupe » | un utilisateur par emplacement, et on tue **tous** ses processus |
| Dépôt dans `/tmp`, relu par l'exécution suivante | **fuite** possible entre utilisateurs | `/tmp` et `/dev/shm` fermés, fichiers privés, `TMPDIR` dans le dossier de l'exécution |
| Bombe de processus | 63 **zombies** restés : l'emplacement ne pouvait plus rien lancer | `init` (tini) récupère les orphelins |
| Lister `/work` | on voyait les dossiers des autres exécutions | `/work` en `0711` (traversable, pas listable) |

Le passage final :

```
calcul et graphique             : 320.67, fichiers loyer.png et loyer.csv
réseau Internet / DNS           : bloqué / bloqué
identité                        : uid 10002, environnement minimal
socket de l'API                 : bloqué
écriture hors du dossier        : bloquée partout
bombe mémoire                   : MemoryError
bombe de processus              : arrêtée à 63
boucle infinie                  : coupée à ~3 s
processus détaché               : tué (0 processus restant)
fuite vers l'exécution suivante : impossible
lien symbolique vers /etc/shadow: créé, mais jamais rendu
```

**Retiens :** une isolation se **prouve** par des attaques. Chaque ligne du
tableau ci-dessus était une hypothèse fausse avant d'être testée.

Autre leçon, plus subtile : sans `CAP_DAC_OVERRIDE`, le serveur (root) ne peut
plus lire un dossier cédé à l'utilisateur d'exécution. C'est voulu (même root ne
passe pas outre les permissions) : les résultats sont relus par un petit
processus qui tourne **sous l'utilisateur de l'exécution**.

## 5. Les fichiers produits

- Types autorisés seulement (images, CSV, texte, JSON, tableur, PDF), 5 Mo au plus,
  8 par exécution, jamais de lien symbolique.
- Analysés par l'antivirus, puis **chiffrés** et rattachés à la réponse (les
  orphelins d'une réponse arrêtée sont purgés après 24 h).
- Affichage : seules les images PNG et JPEG s'affichent, par une URL `blob:` ;
  tout le reste (le SVG compris, qui peut contenir du script) se **télécharge**,
  avec une CSP `sandbox`.

## 6. Qui décide ?

| Niveau | Règle |
|---|---|
| Plateforme | bac à sable installé (profil `code`, `SANDBOX_SOCKET`) |
| Organisation | à activer (désactivé par défaut) |
| Agent | à choisir dans le studio |
| Confidentiel | **permis** : le bac à sable est local, sans réseau, donc rien ne sort |

## Pour vérifier que tu as compris

1. Pourquoi un socket Unix plutôt qu'un port sur un réseau interne ?
2. Pourquoi « tuer le groupe de processus » ne suffit-il pas ?
3. Comment deux exécutions pourraient-elles s'échanger des données, et qu'est-ce
   qui l'empêche ?
4. Pourquoi l'interpréteur est-il permis avec une base confidentielle, alors que
   la recherche web ne l'est pas ?
5. Pourquoi un SVG n'est-il jamais affiché directement ?

## Glossaire

- **rlimit** : limite de ressources du noyau pour un processus (CPU, mémoire…).
- **Zombie** : processus terminé que son parent n'a pas encore « récupéré » ; il
  compte encore dans les limites.
- **gVisor** : noyau en espace utilisateur qui s'interpose entre le conteneur et
  le vrai noyau.
- **Capacité (capability)** : morceau des privilèges de root, attribuable un par un.

**Prochain outil :** MCP, pour brancher des serveurs d'outils standard approuvés.
