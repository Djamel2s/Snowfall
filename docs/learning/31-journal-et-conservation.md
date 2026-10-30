# 31 — Montrer le journal sans l'ouvrir, effacer sans tout lire

## 1. Un journal qu'on ne peut pas réécrire, mais qu'on doit pouvoir lire

Depuis le début, l'application n'a qu'un droit sur `audit_events` : **écrire**.
Elle ne peut ni lire, ni modifier, ni effacer (un trigger l'interdit). C'est ce
qui rend le journal crédible : même une API compromise ne peut pas effacer ses
traces.

Un administrateur doit pourtant pouvoir le consulter. On n'accorde donc pas le
droit de lecture à l'application : on ajoute une **porte étroite**, la fonction
`snowfall_audit_log()`, qui :
- vérifie **en base** que l'appelant est owner ou admin ;
- ne rend que les événements de **son** organisation ;
- n'accepte que des filtres de forme connue (catégorie `^[a-z_]+$`, curseur
  date + identifiant, au plus 500 lignes).

Le test le prouve dans les deux sens : la fonction répond à l'admin, et la
lecture directe de la table est refusée. On l'a même vérifié par mutation : une
fois le droit de lecture accordé exprès, le test échoue.

## 2. La pagination par curseur

Pour paginer le journal, on n'utilise pas « page 3 » (`OFFSET`) : de nouveaux
événements arrivent en continu, et les pages glisseraient. On demande à la place
« les 50 événements *avant* celui-ci », par sa date et son identifiant.
L'identifiant départage deux événements de la même milliseconde, et l'index
(organisation, date) rend la requête rapide.

## 3. L'export CSV, une injection oubliée

Un export CSV semble inoffensif. Pourtant, une cellule qui commence par `=`,
`+`, `-` ou `@` est exécutée comme une **formule** quand on l'ouvre dans Excel
ou LibreOffice : `=HYPERLINK("https://evil…")`, voire pire. Or une partie des
valeurs du journal vient des utilisateurs (un nom de fichier, une cible). On
préfixe donc ces cellules d'une apostrophe, qui les force à rester du texte. Le
test place justement un `=HYPERLINK` dans une cible.

## 4. Effacer après N jours, sans lire les conversations

La conservation (« effacer les conversations sans activité depuis 90 jours »)
pose le même problème que les conversations temporaires. La tâche de fond n'a
pas d'utilisateur, et les conversations sont protégées par la RLS : elle ne peut
pas les lire.

La solution est la même :
- une **file sans contenu**, `conversation_activity` (identifiant,
  organisation, auteur, date), tenue à jour par un trigger ;
- une fonction qui croise cette file avec la durée choisie par chaque
  organisation ;
- l'effacement de chaque conversation **sous l'identité de son auteur**, puis
  la journalisation de chacune.

Garde-fous :
- la durée est choisie dans une liste (30 jours à 3 ans) ;
- les conversations temporaires ont leur propre purge ;
- changer la durée est journalisé, et chaque effacement aussi. Un
  administrateur qui voudrait faire disparaître des traces en laisse donc
  d'autres, dans un journal qu'il ne peut pas effacer.

## 5. RGPD : ne pas tout centraliser

On pourrait imaginer un bouton « exporter toutes les données de Camille » pour
l'administrateur. On ne l'a pas fait. Par conception, l'administrateur ne lit
pas les conversations des autres. Chacun exerce ses droits lui-même, depuis
« Mon compte » (export, suppression), et la rubrique Sécurité le rappelle en une
ligne. La confidentialité tient mieux quand personne n'a la clé de tout.
