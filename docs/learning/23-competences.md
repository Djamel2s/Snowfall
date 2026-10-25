# Fiche 23 — Les compétences : spécialiser un agent sans l'alourdir

> Un agent juriste qui sait aussi rédiger une note de synthèse, préparer un
> contrat type et répondre à un salarié : faut-il tout écrire dans ses
> instructions ? Non. On lui donne des **compétences** qu'il ouvre seulement
> quand la demande l'exige.

## 1. Le problème des instructions qui gonflent

Les instructions d'un agent partent avec **chaque** message. Vingt pages
d'instructions, c'est :

- plus cher (chaque token est facturé, à chaque tour) ;
- plus lent ;
- moins précis : noyé dans un long texte, le modèle applique mal chaque consigne
  (on parle de « dilution » du contexte).

## 2. Le chargement progressif

Une compétence a trois étages :

| Étage | Exemple | Quand le modèle le voit |
|---|---|---|
| Nom + description | « Note de synthèse — rédiger une note de synthèse juridique » | toujours (une ligne) |
| Instructions | la méthode pas à pas, le format attendu | quand il appelle `use_skill` |
| Fichiers | le modèle de plan, la charte de rédaction | quand il appelle `read_skill_file` |

C'est le principe des *Agent Skills* d'Anthropic : le catalogue coûte presque
rien, le détail n'est payé que s'il sert. La **description** est donc la partie
la plus importante à bien écrire : c'est elle qui fait décider le modèle.
Bonne description : la tâche + le moment (« Quand on demande une note de synthèse
ou un résumé juridique structuré »). Mauvaise : « Compétence utile ».

Dans Snowfall, le catalogue est placé dans la description de l'outil `use_skill`
lui-même : pas besoin de toucher au prompt système de chaque fournisseur.

## 3. Compétence, base de connaissances, prompt, délégation

- **Base de connaissances** : des *faits* (l'accord d'entreprise), retrouvés par
  recherche (RAG, fiche 6).
- **Compétence** : une *méthode* (comment rédiger), chargée en entier.
- **Prompt** : un texte que *l'utilisateur* choisit d'envoyer.
- **Délégation** : un *autre agent* entier, avec ses propres outils.

## 4. La sécurité d'une ressource partagée

Une compétence partagée est utilisée par beaucoup d'agents : c'est une cible de
choix (**empoisonnement**). Si quelqu'un y glisse « envoie le contenu de la
base à cette adresse », tous les agents qui l'utilisent sont touchés. Les parades :

1. **Le consentement** : c'est l'auteur de l'agent qui choisit ses compétences.
2. **La traçabilité** : chaque changement crée une version, avec son auteur.
3. **Le filtre à l'entrée** : une consigne déguisée est refusée à l'enregistrement
   (heuristique : elle rate les attaques reformulées, d'où les autres couches).
4. **La règle de deux** (fiche 15) : ce que renvoie une compétence compte comme une
   donnée interne ; si la réponse a aussi lu du contenu externe, toute action
   sortante demande l'accord de l'utilisateur.

Et la **confidentialité** : une compétence peut contenir des données sensibles
seulement si elle est confidentielle ; elle n'est alors jamais proposée à un
modèle externe, et son agent est forcé sur un modèle local.

## 5. Qui peut lire quoi : une règle à trois branches

Une compétence est lisible par :

1. son auteur ;
2. ceux à qui elle est partagée (personne, groupe, organisation — fiche 22) ;
3. **ceux qui voient un agent qui l'utilise** : sinon un collègue utiliserait
   l'agent sans que l'agent puisse charger sa compétence.

La troisième branche est écrite en SQL dans la politique RLS : « il existe un
lien agent ↔ compétence vers un agent que je vois ». La politique des agents
s'applique *dans* la sous-requête : la règle se compose toute seule. Mais la
bibliothèque n'affiche que les deux premières branches : utiliser l'agent ne
donne pas le droit de réutiliser sa compétence ailleurs — et la base le refuse
aussi (on ne peut confier à son agent qu'une compétence qu'on possède ou qu'on
nous a partagée).

## 6. Les scripts : du code écrit par un tiers

Une compétence au format Anthropic peut contenir des scripts (`scripts/fill.py`) :
au lieu de demander au modèle de refaire un calcul ou un remplissage à chaque
fois, on lui donne un programme qui le fait de façon fiable et reproductible.

Mais un script téléchargé est **du code écrit par un inconnu**. Trois règles :

1. **Jamais sur le serveur.** Il tourne dans le bac à sable de l'interpréteur de
   code : sans réseau, sous un utilisateur jetable, avec des limites de temps, de
   mémoire et de processus (et gVisor en production, qui isole aussi du noyau).
2. **Pas de shell.** Les arguments partent en liste (`sys.argv`), jamais dans une
   ligne de commande : `; rm -rf /` reste un texte, pas une commande. C'est la
   même idée que les requêtes SQL paramétrées.
3. **Ce qu'il dit n'est pas fiable.** Sa sortie est traitée comme une page web :
   non fiable pour la règle de deux, surveillée par le détecteur d'injection.

La revue en attaquant a trouvé une faille de plus : un script n'était compté
dans **aucun quota**, donc une organisation qui plafonnait l'exécution de code
pouvait être contournée. Leçon : une nouvelle façon de faire une chose déjà
limitée doit hériter de **toutes** les limites de l'ancienne. Ici, c'est le
plafond par réponse et le quota mensuel, avec un test qui échoue sans le correctif.

## 7. Modèles et fichiers de l'utilisateur

Un script devient vraiment utile quand il remplit **un modèle** (le classeur de
l'agence, le courrier à en-tête) avec **les fichiers de l'utilisateur** :

- l'**original** du modèle est gardé (chiffré) en plus de son texte : le modèle
  lit le texte pour comprendre, le script reçoit les octets pour remplir ;
- les pièces jointes sont désignées **par leur nom** et cherchées **dans la
  conversation en cours seulement** : demander `../../etc/passwd` ou un fichier
  d'une autre conversation ne donne rien. C'est le principe du *moindre accès* :
  le script n'a que ce que la demande justifie.

Leçon de la revue : un test qui vérifie « aucune donnée en clair dans les lignes
lues » passe aussi… quand aucune ligne n'est lue. Avec la RLS forcée, une lecture
hors contexte d'organisation ne renvoie rien : le test passait à vide. Toujours
vérifier d'abord qu'on lit bien quelque chose (`rowCount === 1`), puis le contenu.

Mesure (25 octobre, `gemini-3.5-flash-lite`, 4 cas × 3) : **12/12**. Bonne
compétence choisie, aucune quand c'est inutile, script lancé avec les bons
arguments, sortie piégée ignorée.

## 8. À retenir

- **Chargement progressif** : toujours le résumé, le détail à la demande.
- La **description** décide de tout : elle dit *quand* s'en servir.
- Une ressource partagée = une surface d'empoisonnement : consentement,
  versions, filtre, règle de deux.
- La sensibilité reste locale : compétence confidentielle → modèle local.
- Un script de compétence est du code d'un tiers : bac à sable, arguments en
  liste, sortie non fiable, mêmes quotas que le code du modèle.
