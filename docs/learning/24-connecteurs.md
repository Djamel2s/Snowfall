# Fiche 24 — Les connecteurs : brancher un agent sur Jira, Drive ou GitHub

> Claude et ChatGPT affichent des dizaines de connecteurs avec leurs logos. Que
> se passe-t-il quand on clique sur « Connecter Notion » ? Et pourquoi certains
> demandent-ils une « application OAuth » alors que d'autres non ?

## 1. Un connecteur = un serveur MCP

Le *Model Context Protocol* (fiche 13) décrit comment un agent découvre et
appelle les **outils** d'un service. Beaucoup d'éditeurs hébergent désormais leur
propre serveur MCP : `https://mcp.notion.com/mcp`, `https://mcp.atlassian.com/v2/mcp`…
Un connecteur, c'est donc d'abord une **adresse**, plus une façon de s'authentifier.

Deux transports existent : l'ancien **SSE** (déprécié) et le **Streamable HTTP**
(actuel). Snowfall ne parle que le second ; le catalogue n'a gardé que les
adresses de ce type, sans en deviner aucune.

## 2. Qui se connecte : l'organisation ou chacun ?

- **Jeton d'organisation** (clé d'API) : simple, mais toutes les actions sont
  faites au nom du titulaire de la clé.
- **OAuth par utilisateur** : chacun se connecte avec son compte ; l'agent ne voit
  que ce que *cette personne* a le droit de voir, et ses actions lui sont
  attribuées. C'est le mode à préférer.

## 3. OAuth en trois étapes (et pourquoi certains « demandent une application »)

1. **Découverte** : le serveur MCP dit qui est son serveur d'autorisation
   (`/.well-known/oauth-protected-resource`, RFC 9728).
2. **Client** : pour demander l'autorisation, il faut être un *client* connu de
   l'éditeur. Deux cas :
   - l'éditeur permet l'**enregistrement dynamique** (RFC 7591) : Snowfall se
     déclare tout seul — c'est le « un clic » ;
   - sinon (Google, Microsoft, GitHub, Slack…), un administrateur crée une
     **application OAuth** chez l'éditeur et colle son identifiant.
3. **Autorisation** : l'utilisateur consent chez l'éditeur ; Snowfall reçoit un
   code, l'échange contre un jeton grâce à **PKCE** (un secret à usage unique qui
   empêche un intercepteur d'utiliser le code).

Garde-fous de l'enregistrement dynamique : client « public » (pas de secret à
protéger), une seule adresse de retour — la nôtre —, et le point d'enregistrement
passe les mêmes contrôles que toute adresse tierce (HTTPS, adresse publique).

Certains éditeurs vont plus loin : ils n'acceptent que les clients qu'ils ont
**approuvés** (Figma, par exemple). Un Snowfall auto-hébergé doit alors se faire
enregistrer chez eux : le catalogue le signale.

## 4. Pourquoi un examen avant chaque connecteur

Ajouter un connecteur ne suffit pas : il reste **en attente** jusqu'à ce qu'un
administrateur examine ses outils un par un et décide s'ils **lisent** ou
**écrivent**. Une écriture demande ensuite l'accord de l'utilisateur, à chaque
fois. Et une empreinte de chaque outil approuvé détecte un serveur qui changerait
ses outils en douce (fiche 13).

### Le parcours à l'écran : une action à la fois

Un connecteur suit toujours les mêmes étapes, affichées en haut de sa fiche :
**Ajouté → Connexion (si OAuth) → Outils → Prêt**. La fiche ne propose qu'**un**
bouton principal, celui de l'étape en cours : c'est un principe d'ergonomie
(« divulgation progressive ») qui évite de montrer d'un coup des réglages qu'on
ne comprend pas encore.

Pour les outils, trois choix plutôt qu'une liste brute :

- **Lecture seule (recommandé)** : seulement les outils que l'éditeur annonce
  comme ne modifiant rien (`readOnlyHint` dans MCP) ;
- **Lecture et écriture** : tout, chaque écriture restant soumise à l'accord ;
- **Personnalisé** : outil par outil, avec la description et les paramètres
  exacts que le modèle lira.

Pourquoi « lecture seule » par défaut ? C'est le **moindre privilège** : un agent
qui ne peut pas écrire ne peut pas être poussé (par une injection de prompt dans
un document lu, fiche 13) à supprimer ou envoyer quelque chose. Mais attention :
`readOnlyHint` est une **déclaration** de l'éditeur, pas une garantie ; c'est
pour cela que Snowfall fige l'empreinte de chaque outil et que le mode
personnalisé montre tout.

## 5. Souveraineté : où vont les données ?

Un connecteur envoie les questions et les résultats chez l'éditeur, souvent hors
de l'UE. Trois règles dans Snowfall :

- c'est l'organisation qui choisit chaque connecteur ;
- une conversation confidentielle n'en appelle jamais ;
- la règle de deux (fiche 15) s'applique : contenu externe + action sortante =
  accord demandé.

## 6. Importer une compétence en .zip sans se faire piéger

Un zip peut mentir : quelques Ko annoncés, des Go une fois décompressés (**zip
bomb**). On ne fait donc jamais confiance aux tailles annoncées : on décompresse
**en flux** et on compte chaque octet produit, en s'arrêtant au premier plafond.
Les chemins (`../../etc/passwd`) ne servent qu'à l'affichage : rien n'est écrit
sur le disque.

### Dans le studio de l'agent : choisir ce qu'il peut faire

Le studio présente une section **« Ce que l'agent peut faire »**, avec une ligne
par capacité : ce qu'elle fait en une phrase, et un interrupteur. Les connecteurs
prêts, les agents de son équipe et les compétences se cochent **directement**.
L'outil technique correspondant (`mcp`, `delegate`) est activé tout seul dès qu'un
élément est choisi : l'utilisateur raisonne en « Jira », pas en « outil MCP ».
Les capacités qui écrivent portent la mention « Vous demande avant d'agir » :
c'est l'approbation humaine (*human-in-the-loop*), rendue visible au moment du choix.

« Enregistrer et tester » ouvre aussitôt une conversation avec l'agent. Une
consigne ou un outil se juge en situation, sur une vraie question.

## 7. À retenir

- Connecteur = adresse MCP + mode d'authentification.
- OAuth par utilisateur > clé partagée.
- Enregistrement dynamique quand l'éditeur le permet ; sinon une application à créer.
- Rien n'agit sans examen des outils par un administrateur ; lecture seule par défaut.
- Une fiche, des étapes visibles, une seule action principale à la fois.
- Un zip se lit en flux, avec des plafonds sur ce qui sort vraiment.
