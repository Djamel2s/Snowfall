# 33 — Une bibliothèque de connaissances : changer de modèle sans rien perdre

## 1. Le changement de modèle

Avant, chaque agent et chaque projet avait **sa** base de documents. Simple,
mais peu naturel : un même règlement servait à trois agents, et il fallait
l'importer trois fois. Et rien ne permettait de ranger les documents.

Maintenant, une base est un objet à part entière :
- elle a un nom, un auteur et des dossiers (imbriqués) ;
- elle se **partage**, comme un agent ou un prompt : une personne, un groupe ou
  toute l'organisation, en lecture ou en modification ;
- elle se **rattache** à un ou plusieurs agents et projets, dans un ordre : un
  agent cherche dans toutes ses bases, et enregistre ses notes dans la première
  qu'on peut modifier.

C'est le passage d'une relation « un pour un » à une relation « plusieurs à
plusieurs », avec deux **tables de liaison** (agent ↔ base, projet ↔ base).

## 2. Les droits, portés par la base de données

Qui peut lire une base ? La règle (RLS) dit : son auteur, une personne à qui
elle est partagée, ou quelqu'un qui voit un agent auquel elle est rattachée
(ou un de ses projets). Les documents, passages et dossiers suivent leur base :
« lisible si la base est lisible ».

Trois décisions méritent d'être expliquées :

1. **Rattacher, c'est partager.** Rattacher une base à un agent partagé la rend
   lisible par tous ses utilisateurs. La base de données exige donc de pouvoir
   **modifier** la base, pas seulement la lire, pour la rattacher à un agent.
2. **Pas d'administrateur tout-puissant.** Un administrateur ne lit pas les
   bases des autres, et ne peut pas se les ouvrir par un partage (seul l'auteur
   partage). Les documents d'un projet personnel restent personnels.
3. **L'auteur ne change jamais.** Un éditeur peut ajouter et ranger, pas
   s'approprier la base : un déclencheur fige l'auteur.

En chemin, on a trouvé et corrigé une vraie faiblesse de l'ancien modèle : la
base d'un agent était lisible par **tout** membre de l'organisation au niveau
de la base de données, même si l'agent était privé. Seule l'application
filtrait. Le nouveau test le montre : Bob ne lit rien tant que l'agent ne lui
est pas partagé.

## 3. Le piège de la récursion

Première exécution des tests : « infinite recursion detected in policy ». La
règle d'écriture d'un rattachement vérifiait le droit de modifier la base. Or
la règle de lecture d'une base consulte les rattachements. PostgreSQL déplie
les règles et voit la boucle.

La solution classique : une petite **fonction** (`snowfall_knowledge_can_edit`)
qui fait la vérification. Une fonction est évaluée à part : la boucle disparaît,
la règle reste la même.

## 4. Migrer sans perdre de données, en quatre temps

On ne peut pas « remplacer » une colonne d'un coup : il faut recopier les
données entre l'ajout du nouveau et le retrait de l'ancien. Drizzle génère une
migration à partir du schéma ; on l'a donc découpée :

1. **ajouter** (nom, auteur, tables de liaison, dossiers) ;
2. **reprendre** l'existant (une base par agent ou projet, avec son auteur et
   son rattachement), écrit à la main ;
3. **retirer** les anciennes colonnes et poser les nouvelles règles ;
4. **contrôler** (déclencheurs, chiffrement imposé, partages).

Et on l'a **essayée** avant de te la donner : une base jetable migrée jusqu'à
la veille, remplie de données à l'ancien format, puis migrée. Rien de perdu, et
les droits vérifiés sous le rôle de l'application.

## 5. Ce que les tests ont attrapé

- La **rotation des clés** parcourait ces tables par une colonne qu'on
  supprimait : le test de couverture (fiche 32) a signalé les nouvelles
  colonnes chiffrées oubliées.
- Après refactorisation, un fichier **infecté** créait une base vide avant
  d'être refusé : l'antivirus passe de nouveau avant tout.
- Chaque règle critique a été **affaiblie exprès** (mutation) : rattacher sans
  droit, lecture d'office par un administrateur, partage par un administrateur,
  dossiers sans contrôle de boucle. À chaque fois, un test échoue.

## 6. Dans l'interface

- Un espace **Connaissances** : « Mes bases », « Partagées avec moi ».
- Une base s'ouvre comme un explorateur : fil d'Ariane, dossiers, documents ;
  on dépose des fichiers dans le dossier ouvert, on déplace un document, on
  partage, on rend confidentielle.
- Dans un agent ou un projet : « Bases de connaissances », un sélecteur. On ne
  propose à un agent que les bases qu'on peut modifier (règle 1).
