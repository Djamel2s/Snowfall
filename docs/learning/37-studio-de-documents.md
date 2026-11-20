# 37 — Studio de documents : faire produire de beaux fichiers à un modèle

## 1. Le modèle décrit, le code met en page

Demander à un modèle d'écrire tout le code d'une présentation PowerPoint, c'est
lui demander de calculer des positions en EMU, des tailles de police et des
couleurs, diapositive par diapositive. Il y arrive, mais le résultat est
inégal : textes qui débordent, couleurs au hasard, une mise en page différente
à chaque fois.

Le studio sépare les rôles :
- le **modèle** décide du contenu et de la structure (« des chiffres clés, puis
  un graphique, puis trois priorités ») ;
- le **module** `snowfall_docs` garantit la forme : grille, marges, hiérarchie
  typographique, palette, taille du texte adaptée à sa longueur.

C'est le principe d'un système de design, appliqué à un agent. Le modèle écrit
dix lignes lisibles au lieu de deux cents fragiles, et il se trompe moins.

## 2. Une documentation que le modèle lit à la demande

Décrire toute l'API dans la description de l'outil alourdirait **chaque**
requête de milliers de jetons. Le module porte son propre mode d'emploi :
`print(snowfall_docs.guide("deck"))`. Le modèle le lit quand il en a besoin,
dans une exécution, comme un humain ouvrirait une page de documentation.
C'est la même idée que les compétences (fiche 30) : charger le savoir au
moment où il sert.

Le guide contient aussi des **règles de qualité** : un message par
diapositive, des titres qui donnent la conclusion, des chiffres avec leur unité
et leur source, des mises en page variées.

## 3. Natif plutôt qu'image

Dans PowerPoint et Excel, les graphiques sont **natifs** : l'utilisateur peut
modifier les données, changer les couleurs, les recopier. Une image de
graphique est plus simple à produire, mais devient un cul-de-sac. Dans Word, en
revanche, un graphique natif est mal pris en charge par les bibliothèques : on
y met une image haute définition, aux couleurs du thème.

## 4. Les polices, un détail qui n'en est pas un

Un document Office ne contient pas ses polices : il indique leur nom.
Calibri existe partout où Office est installé, mais pas dans le bac à sable.
Carlito a exactement les mêmes mesures : un rapport converti en PDF garde
donc la même mise en page qu'à l'écran. Choisir une police « jolie » absente
chez le destinataire, c'est lui envoyer un document qui se recompose.

## 5. Suivre le modèle de l'utilisateur

Trois cas, trois outils :
- une **présentation modèle** : on reprend son masque, ses couleurs et ses
  polices, on retire ses diapositives d'exemple, on remplit ses mises en page ;
- un **document Word à styles** : on garde ses styles, en-têtes et pieds de page ;
- un **document Word à champs** (`{{ client }}`) : on remplit les champs
  (Jinja), avec échappement automatique : une donnée « <script> » reste du texte.

## 6. Ce qu'on ne laisse pas sortir

Un fichier Office est une archive zip. Elle peut contenir une macro, un objet
incorporé, ou un lien qu'Office suivra à l'ouverture : un modèle distant qui
fait fuiter les identifiants réseau de l'utilisateur, une image distante qui
le piste. Le modèle qui écrit le document a pu être manipulé par une page web
ou un document (injection). Avant d'être donné, chaque fichier est donc
contrôlé : seuls les liens hypertextes web ou courriel sortent. Le contrôle a
été testé sur de **vrais** documents du bac à sable, ce qui a révélé un faux
positif : les réglages d'impression du modèle PowerPoint par défaut, un fichier
binaire inoffensif, admis seulement à leur emplacement exact.

## 7. Ouvrir une porte avec précaution

LibreOffice veut créer un canal de communication dans `/tmp`, chemin écrit en
dur dans son code. Or `/tmp` est fermé aux exécutions. Plutôt que de le
rouvrir, on ouvre `/var/tmp` en mode 1733 : chacun peut y écrire, personne ne
peut le lister, tout fichier est privé et il est vidé après chaque exécution.
La batterie d'attaques le vérifie, et elle échoue si on oublie de le vider.

## 8. Mesuré avec un vrai modèle (17 novembre)

Les tests écrits à la main passaient tous. Le premier essai avec Gemini Flash-Lite
dans le vrai bac à sable a échoué : le modèle a tourné en boucle jusqu'à la
limite d'étapes, sans rien livrer. Le journal de chaque exécution a montré
pourquoi :
- il lisait le guide en **trois** fois (général, puis « deck », puis « pdf ») ;
- il inventait des noms d'arguments plausibles (`chart_type=`, `left_items=`,
  `author=`, `note=` pour `notes=`) et chaque erreur Python lui coûtait une étape ;
- une fois les outils retirés (limite atteinte), il demandait **encore** un outil,
  et la boucle d'agent l'exécutait : erreur au lieu d'une réponse. C'était un défaut
  de Snowfall, pas du modèle, corrigé et testé.

Corrections : `guide()` donne tout en une fois ; le module comprend les noms
courants et ignore un argument inconnu en le signalant (au lieu d'échouer) ; la
boucle ignore un appel d'outil quand elle n'en propose plus. Résultat : 3 cas sur
3 réussis (présentation, rapport, classeur).

Regarder les fichiers, pas seulement les contrôles, a révélé deux autres défauts :
- **le sommaire du PDF était vide** alors que le guide disait « sommaire calculé ».
  Le test acceptait n'importe quel chiffre : il passait avec des numéros tous à 1.
  Il compare maintenant chaque numéro à la page réelle du titre, et une mutation
  prouve qu'il attrape l'ancien défaut ;
- les nombres à l'anglaise (« 0.9 M€ ») : LibreOffice suivait la langue du système.

Ce qui reste : le modèle **invente** encore des détails (délais par gravité,
source « ITSM »), même avec la consigne dans le guide et dans la description de
l'outil. Une consigne réduit le problème, elle ne le supprime pas. La parade
suivante est un contrôle : comparer les chiffres du document à ceux de la demande
et signaler au modèle ceux qui n'y figurent pas.

À retenir : un banc d'évaluation qui garde les fichiers produits
(`--keep-files`) et un humain qui les **regarde** trouvent ce que les contrôles
automatiques laissent passer.
